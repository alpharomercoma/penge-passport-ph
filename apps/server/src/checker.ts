// One checker run: scan every site, store the scan, and only if the scan
// passes its health checks, compare it with the last good one and email the
// people waiting for dates that just opened.
//
// Guardrails, in order:
//  1. One run at a time (a lock in Redis, so a laptop cannot race the server).
//  2. An unhealthy scan (site list missing, >20% of sites failing, or no site
//     publishing any dates) sends nothing and leaves every baseline alone.
//  3. A site that failed, or publishes no dates, keeps its baseline, so a
//     glitch can never make every date look new on the next run.
//  4. The first observation of anything is a baseline, never an alert.
//  5. A date is announced at most once per 3 hours, however often it flickers.
//  6. Pace: one alert an hour per person (or one per check if they chose it);
//     what comes in between waits and joins their next email. Caps: alerts per
//     person per day, and emails per day in total.
//  7. Only dates open at the latest good look are sent; one that closed while
//     it waited keeps waiting, in case it opens again. Alerts older than 3
//     hours are dropped: stale news is noise.
//  8. Three mail failures in a row stop delivery; the rest waits for the next run.
//  9. A Redis flag (pp:mail:paused) pauses all delivery at once, checked before every email.
// 10. Baselines, announcement marks and queued alerts are written in one
//     transaction, so a crash cannot record a date as seen without its alert.
// 11. A run is bounded: at most MAX_SITES offices and SCAN_BUDGET_MS of scanning,
//     under a lock it renews as it goes and gives up if it loses.
// 12. Queued alerts are signed; one altered in Redis is dropped, not sent.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { type Availability, CircuitOpenError, type Site } from 'penge-passport-ph';
import { describePost, officeMapUrl, officePhone, type Pace, type SiteStatus, type StatusResponse } from '@penge/contracts';
import {
  ABROAD_DEADLINE_MS,
  ABROAD_GROUP_CAP,
  ABROAD_POSTS_PER_RUN,
  ABROAD_REQUESTS_PER_RUN,
  type AbroadUpstream,
  CATALOG_STEPS_PER_RUN,
  catalogPosts,
  scanAbroad,
  stepCatalog,
  writeAbroadStatus,
} from './abroad.ts';
import { unsubscribeLinks } from './api.ts';
import { exportSubscribers } from './backup.ts';
import { K, manilaDay } from './keys.ts';
import type { Kv, WriteOp } from './kv.ts';
import type { Logger } from './log.ts';
import { type Mailer, wasRefused } from './mailer.ts';
import type { SnapshotSink } from './r2.ts';
import { reportOncePerDay, type Stats } from './stats.ts';
import {
  assessHealth,
  type GroupObservation,
  newlyOpened,
  parseDates,
  SCAN_SCHEMA,
  type Scan,
  type SiteObservation,
} from './snapshot.ts';
import { emailOf, type Keys, load, type Subscriber } from './subscribers.ts';
import { alertEmail, type Opening } from './templates.ts';

export interface Upstream {
  sites(): Promise<Site[]>;
  availability(query: { siteId: number; applicants: number }): Promise<Availability>;
}

export interface CheckDeps {
  kv: Kv;
  upstream: Upstream;
  /** Posts abroad, on their own rate limiter (abroad.ts); without it only the Philippines is scanned. */
  abroad?: AbroadUpstream;
  /** Check every post abroad this run, due or not: a sweep started by hand (PENGE_ABROAD_SWEEP=1). */
  abroadSweep?: boolean;
  sink: SnapshotSink;
  mailer: Mailer;
  keys: Keys;
  log: Logger;
  publicBaseUrl: string;
  mailDailyLimit: number;
  alertsPerSubscriberPerDay: number;
  /** Recorded in each scan, e.g. "penge-passport-ph@0.1.0". */
  client: string;
  /** The day's numbers (stats.ts), and who gets them by email each morning. */
  stats?: Stats;
  statsEmail?: string | null;
  now?: () => number;
  runId?: string;
}

export const ANNOUNCE_WINDOW_SECONDS = 3 * 3600;
/** Alerts waiting longer than this are dropped, even about dates still open: by then they are not news. */
export const OUTBOX_MAX_AGE_MS = 3 * 3600_000;
/**
 * The least time between two alerts to one person. "hourly" is a full hour:
 * checks start every 15 minutes, so the next email goes at the first check an
 * hour or more after the last one. "asap" is one email per check at most (a
 * check emails a person once, whether their dates came from the Philippines or
 * from the posts abroad later in it), with a 5-minute floor between checks.
 */
export const PACE_SPACING_MS: Record<Pace, number> = { hourly: 60 * 60_000, asap: 5 * 60_000 };
const HELD_TTL_SECONDS = OUTBOX_MAX_AGE_MS / 1000 + 3600;
const LAST_ALERT_TTL_SECONDS = 2 * 3600;
/** Extra lookups per run for group sizes; each is one more request to the site (budget.ts has the sum). */
export const GROUP_QUERY_CAP = 10;
/** Offices that answered with an error are tried once more, this many at most per run. */
export const RETRY_CAP = 3;
/**
 * A scan that still has this many offices answering with errors (after the
 * retries), or that the rate limiter paused, makes the next scans wait
 * COOLDOWN_SECONDS: the next run is skipped, so a struggling site is asked
 * every 30 minutes, not every 15.
 */
export const COOLDOWN_ERRORS = 3;
export const COOLDOWN_SECONDS = 20 * 60;
export const LOCK_TTL_SECONDS = 20 * 60;
/** More offices than this and the list itself is suspect (there are 43 in 2026). */
export const MAX_SITES = 150;
/**
 * Fewer offices than this share of the last good list, and the list is more
 * likely cut short than offices closed: the run is distrusted, and the last
 * good list stays.
 */
export const MIN_KEPT_FRACTION = 0.8;
/** Offices not reached within this are recorded as skipped (the systemd timeout is 15 min). */
export const SCAN_BUDGET_MS = 10 * 60_000;
const MAX_MAIL_ATTEMPTS = 3;
const COUNTER_TTL_SECONDS = 2 * 24 * 3600;

export interface AlertJob {
  id: string;
  createdAt: number;
  subscriberId: string;
  applicants: number;
  openings: Opening[];
  /** Refused sends so far, for every date in it (entries written before `tries` existed). */
  attempts?: number;
  /** When each "siteId:date" was first queued, once alerts have been merged; otherwise `createdAt`. */
  dateAt?: Record<string, number>;
  /** Refused sends so far, per "siteId:date", once alerts have been merged. */
  tries?: Record<string, number>;
}

export interface DeliveryReport {
  sent: number;
  dryRun: number;
  skipped: number;
  failed: number;
  dropped: number;
  /** People whose alerts wait for their pace (or the daily limit) after this pass. */
  held: number;
  remaining: number;
  stoppedBy: 'paused' | 'daily limit' | 'mail errors' | null;
}

export interface AbroadReport {
  /** Posts asked this run, and how many of them failed. */
  checked: number;
  failed: number;
  /** Steps taken in reading the list of posts (weekly). */
  catalogSteps: number;
  /** False when too many posts failed, or the rate limiter paused: no alerts from them this run. */
  trusted: boolean;
  queued: number;
  problems: string[];
}

export interface RunReport {
  runId: string;
  skipped: 'locked' | 'cooling down' | null;
  healthy: boolean;
  problems: string[];
  uploaded: boolean;
  queued: number;
  delivery: DeliveryReport | null;
  abroad: AbroadReport | null;
}

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** Outbox entries carry an HMAC, so whoever can write to Redis cannot make us email subscribers. */
export function sealJob(job: AlertJob, key: Buffer): string {
  const body = JSON.stringify(job);
  return JSON.stringify({ job: body, mac: createHmac('sha256', key).update(`outbox:${body}`).digest('base64url') });
}

export function openJob(raw: string, key: Buffer): AlertJob | null {
  try {
    const { job, mac } = JSON.parse(raw) as { job?: unknown; mac?: unknown };
    if (typeof job !== 'string' || typeof mac !== 'string') return null;
    const want = Buffer.from(createHmac('sha256', key).update(`outbox:${job}`).digest('base64url'));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got) ? (JSON.parse(job) as AlertJob) : null;
  } catch {
    return null;
  }
}

function newRunId(now: number): string {
  return `${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** Loads each subscriber at most once per run. */
function subscriberCache(kv: Kv) {
  const cache = new Map<string, Promise<Subscriber | null>>();
  return (id: string) => {
    let hit = cache.get(id);
    if (!hit) cache.set(id, (hit = load(kv, id)));
    return hit;
  };
}

type LoadSubscriber = ReturnType<typeof subscriberCache>;

export async function runCheck(deps: CheckDeps): Promise<RunReport> {
  const { kv, log } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const runId = deps.runId ?? newRunId(started);

  if (await kv.get(K.scanCooldown)) {
    log.info('the site had trouble on a recent scan; resting before the next', { runId });
    return { runId, skipped: 'cooling down', healthy: false, problems: [], uploaded: false, queued: 0, delivery: null, abroad: null };
  }
  if (!(await kv.set(K.checkLock, runId, { nx: true, ttlSeconds: LOCK_TTL_SECONDS }))) {
    log.warn('another check is running; skipping this one', { runId });
    return { runId, skipped: 'locked', healthy: false, problems: [], uploaded: false, queued: 0, delivery: null, abroad: null };
  }
  try {
    const holdLock = async () => {
      if ((await kv.get(K.checkLock)) !== runId) throw new Error('lost the checker lock; stopping this run');
      await kv.set(K.checkLock, runId, { ttlSeconds: LOCK_TTL_SECONDS });
    };
    const loadSubscriber = subscriberCache(kv);
    const scan = await scanAll(deps, runId, now, loadSubscriber, holdLock);
    deps.stats?.count('runs');
    if (scan.healthy) deps.stats?.count('healthyRuns');
    const siteErrors = scan.sites.filter((s) => !s.ok && !s.error?.startsWith('skipped:')).length;
    const paused = scan.sites.some((s) => s.error === 'skipped: the rate limiter paused requests');
    if (siteErrors >= COOLDOWN_ERRORS || paused) {
      await kv.set(K.scanCooldown, runId, { ttlSeconds: COOLDOWN_SECONDS });
      log.warn('the site struggled; the next scans wait', { runId, siteErrors, paused, seconds: COOLDOWN_SECONDS });
    }
    await holdLock();
    const uploaded = await deps.sink.put(scan);
    await writeStatus(kv, scan);
    let queued = 0;
    if (scan.healthy) {
      await holdLock();
      queued = await queueAlerts(deps, scan, now, loadSubscriber);
    } else {
      log.warn('unhealthy run: no alerts, baselines unchanged', { runId, problems: scan.problems });
    }
    // One email per person per check: the posts abroad join the next check's email.
    const emailed = new Set<string>();
    let delivery = await deliver(deps, now, emailed);
    // Posts abroad come after the Philippines' alerts are out, so they never delay them.
    let abroad: AbroadReport | null = null;
    if (deps.abroad) {
      abroad = await abroadPass(deps, deps.abroad, scan.runId, now, started + ABROAD_DEADLINE_MS, loadSubscriber, holdLock);
      if (abroad.queued > 0) delivery = addDelivery(delivery, await deliver(deps, now, emailed));
    }
    await backupOncePerDay(deps, now, runId);
    await deps.stats?.settled();
    await reportOncePerDay(deps, now());
    return { runId, skipped: null, healthy: scan.healthy, problems: scan.problems, uploaded, queued, delivery, abroad };
  } finally {
    if ((await kv.get(K.checkLock)) === runId) await kv.write([{ op: 'del', key: K.checkLock }]);
  }
}

/**
 * Daily subscriber backups are kept this many days, so an address removed on
 * unsubscribing is gone from the backups too (still encrypted until then).
 */
export const BACKUP_KEEP_DAYS = 14;
const backupKey = (day: string) => `backups/subscribers/date=${day}/subscribers.json.gz`;

/**
 * The day's copy of every subscriber (still encrypted) goes to R2, and every
 * copy BACKUP_KEEP_DAYS old or older is deleted, however long the checker was
 * away. A failure retries on the next run.
 */
async function backupOncePerDay(deps: CheckDeps, now: () => number, runId: string) {
  const { kv, log, sink } = deps;
  if (!sink.putObject) return;
  const day = manilaDay(now());
  if (!(await kv.set(K.backupDone(day), runId, { nx: true, ttlSeconds: 2 * 24 * 3600 }))) return;
  try {
    const raw = await kv.get(K.sites);
    const siteIds = raw ? (JSON.parse(raw) as { id: number }[]).map((s) => s.id) : [];
    for (const post of await catalogPosts(kv)) siteIds.push(post.id);
    const backup = await exportSubscribers(kv, siteIds, now());
    await sink.putObject(backupKey(day), gzipSync(JSON.stringify(backup)), 'application/gzip');
    log.info('subscriber backup stored', { day, subscribers: backup.subscribers.length });
    if (sink.listObjects && sink.deleteObject) {
      const oldest = manilaDay(now() - (BACKUP_KEEP_DAYS - 1) * 86_400_000); // the oldest day kept
      for (const key of await sink.listObjects('backups/subscribers/')) {
        const kept = /date=(\d{4}-\d{2}-\d{2})\//.exec(key)?.[1];
        if (kept && kept < oldest) await sink.deleteObject(key);
      }
    }
  } catch (err) {
    await kv.write([{ op: 'del', key: K.backupDone(day) }]);
    log.error('subscriber backup failed; the next run retries', { err: err as Error });
  }
}

async function scanAll(
  deps: CheckDeps,
  runId: string,
  now: () => number,
  loadSubscriber: LoadSubscriber,
  holdLock: () => Promise<void>,
): Promise<Scan> {
  const started = now();
  const startedAt = new Date(started).toISOString();
  const problems: string[] = [];
  let list: Site[] = [];
  let loaded = false;
  try {
    list = await deps.upstream.sites();
    loaded = true;
  } catch (err) {
    problems.push(`site list: ${message(err)}`);
  }
  if (list.length > MAX_SITES) {
    // Scanning them all would blow the request budget; distrust the list instead.
    problems.push(`the site list has ${list.length} offices, more than the ${MAX_SITES} expected`);
    list = [];
  }
  if (loaded && list.length > 0) {
    const known = await deps.kv.get(K.sites);
    const before = known ? (JSON.parse(known) as unknown[]).length : 0;
    if (list.length < before * MIN_KEPT_FRACTION) {
      problems.push(`the site list shrank from ${before} to ${list.length} offices`);
    }
  }

  const failed = (site: Site, error: string): SiteObservation => ({
    id: site.id,
    name: site.name,
    address: site.address,
    telephone: site.telephone,
    mapUrl: site.mapUrl,
    ok: false,
    error,
    from: null,
    to: null,
    publishedDays: 0,
    openDates: [],
    days: [],
    fetchedAt: null,
  });

  let circuitOpen = false;
  const observe = async (site: Site): Promise<SiteObservation> => {
    await holdLock();
    try {
      const a = await deps.upstream.availability({ siteId: site.id, applicants: 1 });
      return {
        id: site.id,
        name: site.name,
        address: site.address,
        telephone: site.telephone,
        mapUrl: site.mapUrl,
        ok: true,
        error: null,
        from: a.from,
        to: a.to,
        publishedDays: a.days.length,
        openDates: [...a.availableDates].sort(),
        days: a.days,
        fetchedAt: a.fetchedAt,
      };
    } catch (err) {
      if (err instanceof CircuitOpenError) circuitOpen = true;
      return failed(site, message(err));
    }
  };

  const sites: SiteObservation[] = [];
  for (const site of list) {
    if (circuitOpen) sites.push(failed(site, 'skipped: the rate limiter paused requests'));
    else if (now() - started > SCAN_BUDGET_MS) sites.push(failed(site, 'skipped: the scan ran out of time'));
    else sites.push(await observe(site));
  }
  // The site answers an office with an error a few times a day, then answers
  // it fine: one more try at the end spares that office a scan's worth of
  // "couldn't check".
  let retries = RETRY_CAP;
  for (let i = 0; i < sites.length && retries > 0; i++) {
    if (sites[i]!.ok || sites[i]!.error?.startsWith('skipped:')) continue;
    if (circuitOpen || now() - started > SCAN_BUDGET_MS) break;
    retries--;
    sites[i] = await observe(list[i]!);
  }

  const health = assessHealth(loaded, sites);
  const healthy = health.healthy && problems.length === 0;
  const groups = healthy && !circuitOpen ? await scanGroups(deps.kv, deps.upstream, sites, loadSubscriber, GROUP_QUERY_CAP) : [];
  return {
    schema: SCAN_SCHEMA,
    runId,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    source: { host: 'passport.gov.ph', client: deps.client },
    healthy,
    problems: [...problems, ...health.problems],
    sites,
    groups,
  };
}

/**
 * A date with room for 3 people has room for 1, so group sizes need their own
 * lookup only at sites that have room for 1 and have subscribers who asked
 * for more. Lookups past the cap are recorded as skipped.
 */
async function scanGroups(
  kv: Kv,
  upstream: Pick<Upstream, 'availability'>,
  sites: SiteObservation[],
  loadSubscriber: LoadSubscriber,
  cap: number,
) {
  const groups: GroupObservation[] = [];
  let budget = cap;
  let stop: string | null = null;
  for (const site of sites) {
    if (!site.ok || site.openDates.length === 0) continue;
    const sizes = new Set<number>();
    for (const id of await kv.sMembers(K.siteSubscribers(site.id))) {
      const sub = await loadSubscriber(id);
      if (sub && sub.applicants > 1) sizes.add(sub.applicants);
    }
    for (const applicants of [...sizes].sort((a, b) => a - b)) {
      const skip = (error: string) => groups.push({ siteId: site.id, applicants, ok: false, error, openDates: [] });
      if (stop) {
        skip(stop);
        continue;
      }
      if (budget-- <= 0) {
        skip(`skipped: more than ${cap} group lookups this run`);
        continue;
      }
      try {
        const a = await upstream.availability({ siteId: site.id, applicants });
        groups.push({ siteId: site.id, applicants, ok: true, error: null, openDates: [...a.availableDates].sort() });
      } catch (err) {
        skip(message(err));
        if (err instanceof CircuitOpenError) stop = 'skipped: the rate limiter paused requests';
      }
    }
  }
  return groups;
}

/** Posts abroad failing beyond this share (or 2, whichever is more) make a run's posts untrusted: no alerts from them. */
export const ABROAD_MAX_FAILED_FRACTION = 0.5;

/**
 * One run's share of the posts abroad: a few steps of reading their list, the
 * posts most overdue, their status, and alerts for dates that just opened
 * there, by the same rules as at home (baselines first, 3-hour announce
 * window, caps). Stored in R2 beside the scans, under scans-abroad/.
 */
async function abroadPass(
  deps: CheckDeps,
  upstream: AbroadUpstream,
  runId: string,
  now: () => number,
  deadline: number,
  loadSubscriber: LoadSubscriber,
  holdLock: () => Promise<void>,
): Promise<AbroadReport> {
  const { kv, log } = deps;
  const more = () => now() < deadline;
  const startedAt = new Date(now()).toISOString();
  // The list and the posts share ABROAD_REQUESTS_PER_RUN; until the list is first read in full, it takes them all.
  const firstReading = (await kv.get(K.abroadCatalogAt)) === null;
  const catalog = await stepCatalog(kv, upstream, now, more, log, firstReading ? ABROAD_REQUESTS_PER_RUN : CATALOG_STEPS_PER_RUN);
  const maxPosts = Math.min(ABROAD_POSTS_PER_RUN, ABROAD_REQUESTS_PER_RUN - catalog.steps);
  const { observations, circuitOpen } = await scanAbroad({ kv, upstream, now, more, holdLock, maxPosts, all: deps.abroadSweep === true });
  const followed = new Set<number>();
  for (const o of observations) if ((await kv.sMembers(K.siteSubscribers(o.id))).length > 0) followed.add(o.id);
  await writeAbroadStatus(kv, observations, now(), (id) => followed.has(id));

  const failed = observations.filter((o) => !o.ok).length;
  const trusted = observations.length > 0 && !circuitOpen && failed <= Math.max(2, observations.length * ABROAD_MAX_FAILED_FRACTION);
  const problems = [...catalog.problems, ...observations.filter((o) => !o.ok).map((o) => `${o.name}: ${o.error}`)];
  // Alerts name a post the way people know it: "Copenhagen (Philippine Embassy, Denmark)".
  const sites: SiteObservation[] = observations.map(({ post, ...o }) => {
    const d = describePost(post.name, post.country);
    return { ...o, name: `${d.place} (${d.detail})` };
  });
  const groups = trusted ? await scanGroups(kv, upstream, sites, loadSubscriber, ABROAD_GROUP_CAP) : [];
  const scan: Scan = {
    schema: SCAN_SCHEMA,
    runId,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    source: { host: 'passport.gov.ph', client: deps.client },
    healthy: trusted,
    problems,
    sites,
    groups,
  };
  let queued = 0;
  if (trusted) {
    await holdLock();
    queued = await queueAlerts(deps, scan, now, loadSubscriber);
  } else if (observations.length > 0) {
    log.warn('posts abroad: too many failed this run; no alerts from them', { runId, failed, circuitOpen });
  }
  if (observations.length > 0 && deps.sink.putObject) {
    const stamp = startedAt.replace(/[:.]/g, '-');
    // Kept with the posts' own names and places, for analysis.
    const stored = { ...scan, sites: observations };
    await deps.sink
      .putObject(`scans-abroad/v${SCAN_SCHEMA}/date=${startedAt.slice(0, 10)}/${stamp}_${runId}.json.gz`, gzipSync(JSON.stringify(stored)), 'application/gzip')
      .catch((err: unknown) => log.warn('posts abroad: the record did not reach R2', { runId, err: err as Error }));
  }
  return { checked: observations.length, failed, catalogSteps: catalog.steps, trusted, queued, problems };
}

function addDelivery(a: DeliveryReport, b: DeliveryReport): DeliveryReport {
  return {
    sent: a.sent + b.sent,
    dryRun: a.dryRun + b.dryRun,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    dropped: a.dropped + b.dropped,
    held: b.held,
    remaining: b.remaining,
    stoppedBy: b.stoppedBy ?? a.stoppedBy,
  };
}

async function writeStatus(kv: Kv, scan: Scan) {
  const raw = await kv.get(K.status);
  const previous = raw ? (JSON.parse(raw) as Omit<StatusResponse, 'mailLive'>) : null;
  let status: Omit<StatusResponse, 'mailLive'>;
  if (scan.healthy) {
    const before = new Map(previous?.sites.map((s) => [s.id, s]));
    status = {
      checkedAt: scan.finishedAt,
      lastHealthyAt: scan.finishedAt,
      healthy: true,
      sites: scan.sites.map((s): SiteStatus => {
        // A site that failed this time shows what it had before.
        const old = before.get(s.id);
        if (!s.ok && old) return { ...old, ok: false };
        return {
          id: s.id,
          name: s.name,
          address: s.address,
          telephone: officePhone(s.telephone),
          mapUrl: officeMapUrl(s.mapUrl),
          checkedAt: s.fetchedAt,
          ok: s.ok,
          openDates: s.openDates,
          fullDates: s.days.filter((d) => !d.available).map((d) => d.date).sort(),
          windowEnd: s.to,
          publishedDays: s.publishedDays,
        };
      }),
    };
  } else {
    status = {
      checkedAt: scan.finishedAt,
      lastHealthyAt: previous?.lastHealthyAt ?? null,
      healthy: false,
      sites: previous?.sites ?? [],
    };
  }
  const ops: WriteOp[] = [{ op: 'set', key: K.status, value: JSON.stringify(status) }];
  // Only a trusted run replaces the office list that alerts are checked against.
  if (scan.healthy && scan.sites.length > 0) {
    const list = scan.sites.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    ops.push({ op: 'set', key: K.sites, value: JSON.stringify(list) });
  }
  await kv.write(ops);
}

/**
 * Update baselines, find dates that just opened, and queue one email per
 * subscriber. Everything is read first and written in one transaction.
 */
async function queueAlerts(deps: CheckDeps, scan: Scan, now: () => number, loadSubscriber: LoadSubscriber) {
  const { kv, log } = deps;
  const ops: WriteOp[] = [];
  const openings: { site: SiteObservation; applicants: number; dates: string[] }[] = [];

  for (const site of scan.sites) {
    if (!site.ok || site.publishedDays === 0) continue;
    const previous = await kv.hGetAll(K.openDates(site.id));
    const before1 = parseDates(previous['1']);
    // With no room for 1 person there was no room for any group either.
    const beforeFor = (n: number) => parseDates(previous[String(n)]) ?? (before1?.length === 0 ? [] : undefined);

    const found: [number, string[] | null][] = [[1, newlyOpened(before1, site.openDates)]];
    const fields: Record<string, string> = { '1': JSON.stringify(site.openDates) };
    for (const g of scan.groups.filter((g) => g.siteId === site.id)) {
      const before = beforeFor(g.applicants);
      if (g.ok) {
        fields[g.applicants] = JSON.stringify(g.openDates);
        found.push([g.applicants, newlyOpened(before, g.openDates)]);
      } else if (before !== undefined) {
        fields[g.applicants] = JSON.stringify(before);
      }
    }
    ops.push(
      ...(site.openDates.length === 0
        ? [
            { op: 'del', key: K.openDates(site.id) } as const,
            { op: 'hSet', key: K.openDates(site.id), fields: { '1': '[]' } } as const,
          ]
        : [{ op: 'hSet', key: K.openDates(site.id), fields } as const]),
    );

    for (const [applicants, dates] of found) {
      const fresh: string[] = [];
      for (const date of dates ?? []) {
        // Safe to check, then set: only one checker runs at a time (the lock).
        if ((await kv.get(K.announced(site.id, applicants, date))) === null) fresh.push(date);
      }
      if (fresh.length === 0) continue;
      openings.push({ site, applicants, dates: fresh });
      for (const date of fresh) {
        ops.push({ op: 'set', key: K.announced(site.id, applicants, date), value: scan.runId, ttlSeconds: ANNOUNCE_WINDOW_SECONDS });
      }
    }
  }

  deps.stats?.count('datesOpened', openings.filter((o) => o.applicants === 1).reduce((n, o) => n + o.dates.length, 0));
  const jobs = new Map<string, AlertJob>();
  for (const { site, applicants, dates } of openings) {
    for (const id of await kv.sMembers(K.siteSubscribers(site.id))) {
      const sub = await loadSubscriber(id);
      if (!sub || sub.applicants !== applicants || !sub.siteIds.includes(site.id)) continue;
      let job = jobs.get(id);
      if (!job) {
        job = { id: `${scan.runId}:${id}`, createdAt: now(), subscriberId: id, applicants, openings: [] };
        jobs.set(id, job);
      }
      job.openings.push({ id: site.id, name: site.name, dates });
    }
  }
  for (const job of jobs.values()) job.openings.sort((a, b) => a.name.localeCompare(b.name));
  ops.push({ op: 'rPush', key: K.outbox, values: [...jobs.values()].map((j) => sealJob(j, deps.keys.token)) });
  await kv.write(ops);
  log.info('alerts queued', {
    runId: scan.runId,
    openings: openings.map((o) => `${o.site.id}x${o.applicants}:${o.dates.length}`),
    emails: jobs.size,
  });
  return jobs.size;
}

/** Send what is in the outbox and what waited for its pace, within every cap. */
export async function deliver(
  deps: CheckDeps,
  now: () => number = deps.now ?? Date.now,
  /** People already emailed in this check; each is emailed once per check. */
  emailed: Set<string> = new Set(),
): Promise<DeliveryReport> {
  const { kv, log } = deps;
  const report: DeliveryReport = { sent: 0, dryRun: 0, skipped: 0, failed: 0, dropped: 0, held: 0, remaining: 0, stoppedBy: null };
  const run = { failuresInARow: 0, emailed };
  // Checked before every email, so a pause takes effect mid-run.
  const paused = async () => {
    if (!(await kv.get(K.mailPaused))) return false;
    report.stoppedBy = 'paused';
    log.warn('mail is paused; the outbox waits');
    return true;
  };

  // What the checks found, one entry per person, each joining what that person already has waiting.
  for (let i = 0; i < 5000; i++) {
    if (await paused()) break;
    const raw = await kv.lPop(K.outbox);
    if (raw === null) break;
    const job = openJob(raw, deps.keys.token);
    if (!job) {
      report.dropped++;
      log.warn('dropped an outbox entry with a bad signature');
      continue;
    }
    if ((await consider(deps, job, false, now, report, run)) === 'stop') break;
  }
  // People whose alerts waited for their pace, and may now be due.
  if (!report.stoppedBy) {
    for (const id of await kv.sMembers(K.heldSubscribers)) {
      if (await paused()) break;
      const raw = await kv.get(K.held(id));
      const job = raw === null ? null : openJob(raw, deps.keys.token);
      if (!job || job.subscriberId !== id) {
        if (raw !== null) {
          report.dropped++;
          log.warn('dropped a held alert with a bad signature');
        }
        await clearHeld(kv, id);
        continue;
      }
      if ((await consider(deps, job, true, now, report, run)) === 'stop') break;
    }
  }
  report.held = (await kv.sMembers(K.heldSubscribers)).length;
  report.remaining = await kv.lLen(K.outbox);
  return report;
}

/** Everything in both, one entry per office, dates merged and sorted. */
function mergeOpenings(lists: Opening[][]): Opening[] {
  const byId = new Map<number, Opening>();
  for (const o of lists.flat()) {
    const seen = byId.get(o.id);
    byId.set(o.id, { id: o.id, name: o.name, dates: [...new Set([...(seen?.dates ?? []), ...o.dates])].sort() });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function clearHeld(kv: Kv, subscriberId: string) {
  await kv.write([
    { op: 'del', key: K.held(subscriberId) },
    { op: 'sRem', key: K.heldSubscribers, members: [subscriberId] },
  ]);
}

async function hold(deps: CheckDeps, job: AlertJob) {
  await deps.kv.write([
    { op: 'set', key: K.held(job.subscriberId), value: sealJob(job, deps.keys.token), ttlSeconds: HELD_TTL_SECONDS },
    { op: 'sAdd', key: K.heldSubscribers, members: [job.subscriberId] },
  ]);
}

/**
 * One person's next alert: what `job` brings plus anything they have waiting,
 * less what no longer applies. Sent now if their pace allows, otherwise held
 * for a later check. `fromHeld` when `job` is itself what they had waiting.
 */
async function consider(
  deps: CheckDeps,
  job: AlertJob,
  fromHeld: boolean,
  now: () => number,
  report: DeliveryReport,
  run: { failuresInARow: number; emailed: Set<string> },
): Promise<'next' | 'stop'> {
  const { kv, log, mailer } = deps;
  const id = job.subscriberId;
  const parts: AlertJob[] = [job];
  if (!fromHeld) {
    const raw = await kv.get(K.held(id));
    const waiting = raw === null ? null : openJob(raw, deps.keys.token);
    // A record signed for someone else was moved here by whoever can write to Redis.
    if (waiting && waiting.subscriberId === id) parts.unshift(waiting);
    else if (raw !== null) report.dropped++;
  }
  // When each date was first queued: each is dropped on its own once older than OUTBOX_MAX_AGE_MS.
  const firstAt = new Map<string, number>();
  for (const p of parts) {
    for (const o of p.openings) {
      for (const d of o.dates) {
        const key = dateKey(o.id, d);
        firstAt.set(key, Math.min(firstAt.get(key) ?? Infinity, p.dateAt?.[key] ?? p.createdAt));
      }
    }
  }
  const fresh = (siteId: number, date: string) => now() - (firstAt.get(dateKey(siteId, date)) ?? 0) <= OUTBOX_MAX_AGE_MS;
  for (const p of parts) if (!p.openings.some((o) => o.dates.some((d) => fresh(o.id, d)))) report.dropped++;
  if (![...firstAt.keys()].some((key) => now() - firstAt.get(key)! <= OUTBOX_MAX_AGE_MS)) {
    await clearHeld(kv, id);
    return 'next';
  }

  const sub = await load(kv, id);
  if (!sub) {
    report.skipped++;
    await clearHeld(kv, id);
    return 'next';
  }
  // They may have changed their offices or group size since.
  const wanted = mergeOpenings(parts.filter((p) => p.applicants === sub.applicants).map((p) => p.openings))
    .filter((o) => sub.siteIds.includes(o.id))
    .map((o) => ({ ...o, dates: o.dates.filter((d) => fresh(o.id, d)) }))
    .filter((o) => o.dates.length > 0);
  if (wanted.length === 0) {
    report.skipped++;
    await clearHeld(kv, id);
    return 'next';
  }
  // Refused sends, counted per date: a date that joins a failing alert keeps its own tries.
  const tries = new Map<string, number>();
  for (const p of parts) {
    for (const o of p.openings) {
      for (const d of o.dates) {
        const key = dateKey(o.id, d);
        tries.set(key, Math.max(tries.get(key) ?? 0, p.tries?.[key] ?? p.attempts ?? 0));
      }
    }
  }
  const jobOf = (openings: Opening[]): AlertJob => {
    const dateAt: Record<string, number> = {};
    const tried: Record<string, number> = {};
    for (const o of openings) {
      for (const d of o.dates) {
        const key = dateKey(o.id, d);
        dateAt[key] = firstAt.get(key)!;
        if (tries.get(key)) tried[key] = tries.get(key)!;
      }
    }
    return {
      id: job.id,
      createdAt: Math.min(...Object.values(dateAt)),
      subscriberId: id,
      applicants: sub.applicants,
      openings,
      dateAt,
      ...(Object.keys(tried).length > 0 ? { tries: tried } : {}),
    };
  };
  const holdOps = (held: AlertJob | null): WriteOp[] =>
    held
      ? [
          { op: 'set', key: K.held(id), value: sealJob(held, deps.keys.token), ttlSeconds: HELD_TTL_SECONDS },
          { op: 'sAdd', key: K.heldSubscribers, members: [id] },
        ]
      : [
          { op: 'del', key: K.held(id) },
          { op: 'sRem', key: K.heldSubscribers, members: [id] },
        ];

  // Their pace: too soon after their last alert, or emailed already in this check, it waits.
  const lastRaw = await kv.get(K.lastAlert(id));
  if (run.emailed.has(id) || now() - Number(lastRaw ?? 0) < PACE_SPACING_MS[sub.pace]) {
    await hold(deps, jobOf(wanted));
    return 'next';
  }
  // Only dates open at the latest good look go out. One that closed while it
  // waited keeps waiting, until it is too old: if it opens again, they have
  // still not been told, and a date is announced to everyone once in 3 hours.
  const { open: openings, closed } = await splitByOpen(kv, sub.applicants, wanted);
  const leftover = closed.length > 0 ? jobOf(closed) : null;
  if (openings.length === 0) {
    await hold(deps, jobOf(wanted));
    return 'next';
  }
  const next = jobOf(openings);

  const day = manilaDay(now());
  if (Number((await kv.get(K.alertsToday(id, day))) ?? 0) >= deps.alertsPerSubscriberPerDay) {
    report.skipped++;
    deps.stats?.count('alertsCapped');
    await clearHeld(kv, id);
    return 'next';
  }
  if ((await kv.incr(K.mailSentToday(day), COUNTER_TTL_SECONDS)) > deps.mailDailyLimit) {
    // It all waits uncharged, closed dates too: the allowance is only spent on a send.
    await kv.write([{ op: 'decr', key: K.mailSentToday(day) }, ...holdOps(jobOf(wanted))]);
    report.stoppedBy = 'daily limit';
    log.warn('daily email limit reached; the outbox waits', { limit: deps.mailDailyLimit });
    return 'stop';
  }
  const todays = await kv.incr(K.alertsToday(id, day), COUNTER_TTL_SECONDS);
  // Unsubscribed a moment ago? Then nothing goes out, and nothing is kept.
  // (Checked right before the claim; the two are not one atomic step.)
  if (!(await load(kv, id))) {
    await kv.write([{ op: 'decr', key: K.mailSentToday(day) }, { op: 'decr', key: K.alertsToday(id, day) }, ...holdOps(null)]);
    report.skipped++;
    return 'next';
  }
  // Marked sent before it goes out, as an outbox entry is popped before it is
  // sent: a crash after the send can lose this alert, never send it twice.
  await kv.write([
    { op: 'set', key: K.lastAlert(id), value: String(now()), ttlSeconds: LAST_ALERT_TTL_SECONDS },
    ...holdOps(leftover),
  ]);
  run.emailed.add(id);

  const links = unsubscribeLinks(deps.publicBaseUrl, id, deps.keys);
  const content = alertEmail({
    openings,
    applicants: next.applicants,
    unsubscribeUrl: links.page,
    manageUrl: `${deps.publicBaseUrl}/`,
    lastToday: todays === deps.alertsPerSubscriberPerDay,
  });
  try {
    const result = await mailer.send({ ...content, to: emailOf(sub, deps.keys), kind: 'alert', unsubscribeUrl: links.oneClick });
    if (result === 'sent') {
      report.sent++;
      deps.stats?.count('alertsSent');
    } else if (result === 'dry-run') report.dryRun++;
    else report.skipped++;
    run.failuresInARow = 0;
  } catch (err) {
    report.failed++;
    run.failuresInARow++;
    if (wasRefused(err)) {
      // Nothing was sent: the claim is undone, neither today's total nor the
      // subscriber's allowance is charged, and it is tried again later, all in
      // one write. A date refused MAX_MAIL_ATTEMPTS times is given up on.
      run.emailed.delete(id);
      for (const o of openings) for (const d of o.dates) tries.set(dateKey(o.id, d), (tries.get(dateKey(o.id, d)) ?? 0) + 1);
      const retry = wanted
        .map((o) => ({ ...o, dates: o.dates.filter((d) => (tries.get(dateKey(o.id, d)) ?? 0) < MAX_MAIL_ATTEMPTS) }))
        .filter((o) => o.dates.length > 0);
      await kv.write([
        { op: 'decr', key: K.mailSentToday(day) },
        { op: 'decr', key: K.alertsToday(id, day) },
        lastRaw === null
          ? { op: 'del', key: K.lastAlert(id) }
          : { op: 'set', key: K.lastAlert(id), value: lastRaw, ttlSeconds: LAST_ALERT_TTL_SECONDS },
        ...holdOps(retry.length > 0 ? jobOf(retry) : null),
      ]);
      log.error('alert email refused', { job: next.id, err: err as Error });
    } else {
      // It may have gone out: it stays charged and claimed, and is not sent
      // again, which could make a duplicate.
      log.error('alert email may or may not have gone out; not sending it again', { job: next.id, err: err as Error });
    }
    if (run.failuresInARow >= 3) {
      report.stoppedBy = 'mail errors';
      return 'stop';
    }
  }
  return 'next';
}

const dateKey = (siteId: number, date: string) => `${siteId}:${date}`;

/**
 * Which dates are open at the latest good look, and which have closed. A group
 * fits only where one person does, so a date gone for one person is closed for
 * every group; with no baseline at all, the office was never looked at: open.
 */
async function splitByOpen(kv: Kv, applicants: number, openings: Opening[]) {
  const open: Opening[] = [];
  const closed: Opening[] = [];
  for (const o of openings) {
    const baseline = await kv.hGetAll(K.openDates(o.id));
    const one = parseDates(baseline['1']);
    const group = applicants === 1 ? null : parseDates(baseline[String(applicants)]);
    const isOpen = (d: string) => (!one || one.includes(d)) && (!group || group.includes(d));
    if (o.dates.some(isOpen)) open.push({ ...o, dates: o.dates.filter(isOpen) });
    if (!o.dates.every(isOpen)) closed.push({ ...o, dates: o.dates.filter((d) => !isOpen(d)) });
  }
  return { open, closed };
}
