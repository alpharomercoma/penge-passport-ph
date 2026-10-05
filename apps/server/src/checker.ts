// One checker run: scan every site, store the scan, and only if the scan
// passes its health checks, compare it with the last good one and email the
// people waiting for dates that just opened.
//
// Guardrails, in order:
//  1. One run at a time (a lock in Redis, so a laptop cannot race the server).
//  2. An unhealthy scan (site list missing, >20% of sites failing, or no site
//     publishing any dates) sends nothing from that stream and leaves its baselines alone.
//  3. A site that failed, or publishes no dates, keeps its baseline, so a
//     glitch can never make every date look new on the next run.
//  4. The first observation of anything is a baseline, never an alert.
//  5. A date is announced at most once per 3 hours, however often it flickers.
//  6. Pace: one alert an hour per person (or one per check if they chose it);
//     what comes in between waits and joins their next email. Caps: alerts per
//     person per day, and emails per day in total.
//  7. Only dates verified open in this run are sent; one that closed while
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
  ABROAD_SWEEP_DEADLINE_MS,
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
import { elapsed, parseStamp, type Stamp, stampAt, systemUptime, type Uptime } from './clock.ts';
import type { SnapshotSink } from './r2.ts';
import { beginRecord, type Recorded, type RecordSink, recordRun, skipRecord } from './record.ts';
import { reportOncePerDay, STATS_KEEP_SECONDS, type Stats } from './stats.ts';
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
  /** The kernel's uptime, for paces and ages no wall-clock step can move (clock.ts). */
  uptime?: Uptime;
  /** Reads now as a stamp (clock.ts); runCheck sets it. */
  stampNow?: () => Stamp;
  runId?: string;
}

export const ANNOUNCE_WINDOW_SECONDS = 3 * 3600;
/**
 * Only for tidying up (there can be thousands of marks): the window is measured
 * with the mark's stamp (clock.ts), not by Redis's expiry, which follows the
 * wall clock. A clock jump of more than a week could still expire one early.
 */
const ANNOUNCE_MARK_TTL_SECONDS = 7 * 24 * 3600;
/** First runs of boots: one a reboot. Lost early, a boot's gaps restart once more, which only delays. */
const BOOT_SEEN_TTL_SECONDS = 90 * 24 * 3600;
/** Only for tidying up a held alert that nothing points to any more; a wall-clock jump beyond it can drop one, never send one early. */
const HELD_TTL_SECONDS = 7 * 24 * 3600;
/** Alerts waiting longer than this are dropped, even about dates still open: by then they are not news. */
export const OUTBOX_MAX_AGE_MS = 3 * 3600_000;
/**
 * The least time between two alerts to one person. "hourly" is a full hour:
 * checks start every 5 minutes, so the next email goes at the first check an
 * hour or more after the last one. "asap" is one email per check at most (a
 * check emails a person once, whether their dates came from the Philippines or
 * from the posts abroad later in it), with a 2-minute floor. Checks start 5
 * minutes apart but email at different points in their run (a scan takes 2 to
 * 4 minutes), so two checks' emails can come less than 5 minutes apart: the
 * floor has to be below that, or "asap" would skip every other check.
 */
export const PACE_SPACING_MS: Record<Pace, number> = { hourly: 60 * 60_000, asap: 2 * 60_000 };
// Last-alert times have no expiry in Redis, which would follow the wall clock:
// a clock jump could erase one and let an email go early. They go on unsubscribing.

/**
 * On the first run of a boot, every gap from before it starts again now: how
 * long ago an earlier boot's email was cannot be known (clock.ts), and
 * restarting here, not when each person next has news, makes a reboot cost them
 * at most one pace from the reboot. Under the checker lock; the boot is marked
 * seen only once every gap is restarted, so a crash part-way means another go.
 */
async function restartGapsOnNewBoot(deps: CheckDeps, stamp: () => Stamp) {
  const at = stamp();
  if (at.boot === undefined || at.up === undefined || (await deps.kv.get(K.bootSeen(at.boot))) !== null) return;
  for (const id of await deps.kv.sMembers(K.allSubscribers)) {
    const last = parseStamp(await deps.kv.get(K.lastAlert(id)));
    if (last && elapsed(last, at) === null) {
      await deps.kv.write([{ op: 'set', key: K.lastAlert(id), value: JSON.stringify(at) }]);
    }
  }
  await deps.kv.set(K.bootSeen(at.boot), String(at.up), { ttlSeconds: BOOT_SEEN_TTL_SECONDS });
}
/** Extra lookups per run for group sizes; each is one more request to the site (budget.ts has the sum). */
export const GROUP_QUERY_CAP = 10;
/** Offices that answered with an error are tried once more, this many at most per run. */
export const RETRY_CAP = 3;
/**
 * A scan that still has this many offices answering with errors (after the
 * retries), or that the rate limiter paused, makes the next scans wait
 * COOLDOWN_SECONDS: the next two runs are skipped, so a struggling site is
 * asked every 15 minutes, not every 5.
 */
export const COOLDOWN_ERRORS = 3;
export const COOLDOWN_SECONDS = 10 * 60;
export const LOCK_TTL_SECONDS = 20 * 60;
/** More offices than this and the list itself is suspect (there are 43 in 2026). */
export const MAX_SITES = 150;
/**
 * Fewer offices than this share of the last good list, and the list is more
 * likely cut short than offices closed: the run is distrusted, and the last
 * good list stays.
 */
export const MIN_KEPT_FRACTION = 0.8;
/**
 * How long a run may spend sending the spool, and how far into the run it may
 * still do so, or upload its own records (after that they go to the spool).
 */
export const SPOOL_FLUSH_MS = 30_000;
export const SPOOL_UNTIL_MS = 4.75 * 60_000;
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
  /** When it was queued (clock.ts); entries from before stamps existed have only `createdAt`. */
  queuedAt?: Stamp;
  /** When each "siteId:date" was first queued, once alerts have been merged (a stamp, or a wall-clock number). */
  dateAt?: Record<string, Stamp | number>;
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
  /** What happened to the run's scan record in R2 (record.ts): null when the run was skipped. */
  recorded: Recorded | null;
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

export async function runCheck(given: CheckDeps): Promise<RunReport> {
  const now = given.now ?? Date.now;
  const uptime = given.uptime ?? systemUptime;
  const deps: CheckDeps = { ...given, stampNow: given.stampNow ?? (() => stampAt(now(), uptime)) };
  const { kv, log } = deps;
  const started = now();
  const runId = deps.runId ?? newRunId(started);

  if (await kv.get(K.scanCooldown)) {
    log.info('the site had trouble on a recent scan; resting before the next', { runId });
    return { runId, skipped: 'cooling down', healthy: false, problems: [], recorded: null, queued: 0, delivery: null, abroad: null };
  }
  if (!(await kv.set(K.checkLock, runId, { nx: true, ttlSeconds: LOCK_TTL_SECONDS }))) {
    log.warn('another check is running; skipping this one', { runId });
    return { runId, skipped: 'locked', healthy: false, problems: [], recorded: null, queued: 0, delivery: null, abroad: null };
  }
  try {
    await restartGapsOnNewBoot(deps, deps.stampNow!);
    const holdLock = async () => {
      if ((await kv.get(K.checkLock)) !== runId) throw new Error('lost the checker lock; stopping this run');
      await kv.set(K.checkLock, runId, { ttlSeconds: LOCK_TTL_SECONDS });
    };
    const loadSubscriber = subscriberCache(kv);
    // Said missing until its record is made: a run that stops before then is named by the next (record.ts).
    const begun = await beginRecord(kv, 'scans', runId, new Date(started).toISOString());
    const { scan, listComplete } = await scanAll(deps, runId, now, loadSubscriber, holdLock);
    deps.stats?.count('runs');
    if (scan.healthy) deps.stats?.count('healthyRuns');
    const siteErrors = scan.sites.filter((s) => !s.ok && !s.error?.startsWith('skipped:')).length;
    const paused = scan.sites.some((s) => s.error === 'skipped: the rate limiter paused requests');
    if (siteErrors >= COOLDOWN_ERRORS || paused) {
      await kv.set(K.scanCooldown, runId, { ttlSeconds: COOLDOWN_SECONDS });
      log.warn('the site struggled; the next scans wait', { runId, siteErrors, paused, seconds: COOLDOWN_SECONDS });
    }
    await holdLock();
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
    let delivery = await deliver(deps, now, emailed, [scan]);
    // Posts abroad come after the Philippines' alerts are out, so they never delay them.
    let abroad: AbroadReport | null = null;
    let recordAbroad: ((sink: RecordSink) => Promise<void>) | null = null;
    if (deps.abroad) {
      // A sweep by hand gets its time from when the posts begin; a scheduled run's posts
      // stop at a time counted from the run's start, to end before the next run.
      const deadline = deps.abroadSweep ? now() + ABROAD_SWEEP_DEADLINE_MS : started + ABROAD_DEADLINE_MS;
      const pass = await abroadPass(deps, deps.abroad, scan.runId, now, deadline, loadSubscriber, holdLock);
      abroad = pass.report;
      recordAbroad = pass.record;
      // A held post can become due without any newly announced date. Recheck
      // it only after this run's abroad observations, including their groups.
      if (abroad.trusted && !delivery.stoppedBy) delivery = addDelivery(delivery, await deliver(deps, now, emailed, [scan, pass.scan]));
    }
    // The records come after every alert is out and every post checked, so a slow R2
    // delays neither. Only what changed since the last record (record.ts); nothing at
    // all if nothing did. A run that stops before this is named by the next record.
    // Each upload gets the time left before the next run is due; past that, the record
    // goes to the spool, and up with a later run's.
    const sink: RecordSink = { store: (key, body) => deps.sink.store(key, body, Math.max(0, started + SPOOL_UNTIL_MS - now())) };
    await holdLock();
    let recorded: Recorded | null = null;
    try {
      recorded = await recordRun({ kv, log, sink }, 'scans', scan, { complete: listComplete }, begun);
    } catch (err) {
      log.error('the scan record failed', { runId, err: err as Error });
    }
    await recordAbroad?.(sink);
    // Records spooled while R2 was down go up last, whether or not this run stored
    // one, with the time left before the next run is due (SPOOL_FLUSH_MS at most).
    const left = started + SPOOL_UNTIL_MS - now();
    if (left > 0) await deps.sink.flush?.(Math.min(SPOOL_FLUSH_MS, left));
    await backupOncePerDay(deps, now, runId);
    await deps.stats?.settled();
    await reportOncePerDay(deps, now());
    return { runId, skipped: null, healthy: scan.healthy, problems: scan.problems, recorded, queued, delivery, abroad };
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
): Promise<{ scan: Scan; listComplete: boolean }> {
  const started = now();
  const startedAt = new Date(started).toISOString();
  const problems: string[] = [];
  let list: Site[] = [];
  let loaded = false;
  // Whether the office list can be taken as every office there is: an office
  // missing from it has then been removed (record.ts). Not when it failed to
  // load, was too long to scan, or came back cut short.
  let listComplete = true;
  try {
    list = await deps.upstream.sites();
    loaded = true;
  } catch (err) {
    problems.push(`site list: ${message(err)}`);
    listComplete = false;
  }
  if (list.length > MAX_SITES) {
    listComplete = false;
    // Scanning them all would blow the request budget; distrust the list instead.
    problems.push(`the site list has ${list.length} offices, more than the ${MAX_SITES} expected`);
    list = [];
  }
  // A list that loads but lists no office is no more complete than one that failed.
  if (loaded && list.length === 0) listComplete = false;
  if (loaded && list.length > 0) {
    const known = await deps.kv.get(K.sites);
    const before = known ? (JSON.parse(known) as unknown[]).length : 0;
    if (list.length < before * MIN_KEPT_FRACTION) {
      problems.push(`the site list shrank from ${before} to ${list.length} offices`);
      listComplete = false;
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
  const scan: Scan = {
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
  return { scan, listComplete: listComplete && loaded };
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
  /** False once the run is out of time: the lookups left are recorded as skipped. */
  more: () => boolean = () => true,
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
      if (!more()) {
        skip('skipped: the run ran out of time');
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
): Promise<{ report: AbroadReport; scan: Scan; record: (sink: RecordSink) => Promise<void> }> {
  const { kv, log } = deps;
  const more = () => now() < deadline;
  const startedAt = new Date(now()).toISOString();
  const begun = await beginRecord(kv, 'scans-abroad', runId, startedAt);
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
  const groups = trusted ? await scanGroups(kv, upstream, sites, loadSubscriber, ABROAD_GROUP_CAP, more) : [];
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
  // Kept with the posts' own names and places, for analysis, once every alert is out (runCheck).
  const record = async (sink: RecordSink) => {
    if (observations.length === 0) {
      // No post was due: nothing is missing. Should this fail, the next record names a run that saw nothing.
      await skipRecord(kv, 'scans-abroad', begun).catch((err: unknown) => log.warn('posts abroad: could not clear the run\'s mark', { runId, err: err as Error }));
      return;
    }
    // A run checks a dozen posts: the others are unchanged, not gone, unless the
    // list of posts, once read in full, no longer has them (record.ts).
    try {
      // The list of posts says which are gone only once read in full, and not while it is
      // being read again (steps still planned): part old, part new, it could drop a post.
      // Nor when it read as empty: as at home, more likely a fault than every post gone.
      const listRead = (await kv.get(K.abroadCatalogAt)) !== null && (await kv.lLen(K.abroadPlan)) === 0;
      const known = listRead ? (await catalogPosts(kv)).map((p) => p.id) : [];
      await recordRun({ kv, log, sink }, 'scans-abroad', { ...scan, sites: observations }, known.length > 0 ? { complete: false, known } : { complete: false }, begun);
    } catch (err) {
      // The alerts stand, and the next record names this one (record.ts).
      log.warn('posts abroad: the record failed', { runId, err: err as Error });
    }
  };
  return { report: { checked: observations.length, failed, catalogSteps: catalog.steps, trusted, queued, problems }, scan, record };
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

/** The status as stored in pp:status: what /api/status adds (mail and push) is not stored. */
export type StoredStatus = Omit<StatusResponse, 'mailLive' | 'push' | 'vapidPublicKey'>;

async function writeStatus(kv: Kv, scan: Scan) {
  const raw = await kv.get(K.status);
  const previous = raw ? (JSON.parse(raw) as StoredStatus) : null;
  let status: StoredStatus;
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
  const queued = (deps.stampNow ?? (() => stampAt(now(), deps.uptime)))();

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
        const key = K.announced(site.id, applicants, date);
        const mark = await kv.get(key);
        if (mark === null) {
          fresh.push(date);
          continue;
        }
        const stamp = parseStamp(mark);
        if (stamp === null) continue; // written before marks had stamps: its 3-hour expiry decides
        const age = elapsed(stamp, queued);
        if (age === null) {
          // Its age cannot be known (clock.ts), so its 3 hours start again now.
          ops.push({ op: 'set', key, value: JSON.stringify(queued), ttlSeconds: ANNOUNCE_MARK_TTL_SECONDS });
        } else if (age >= ANNOUNCE_WINDOW_SECONDS * 1000) {
          fresh.push(date);
        }
      }
      if (fresh.length === 0) continue;
      openings.push({ site, applicants, dates: fresh });
      for (const date of fresh) {
        ops.push({ op: 'set', key: K.announced(site.id, applicants, date), value: JSON.stringify(queued), ttlSeconds: ANNOUNCE_MARK_TTL_SECONDS });
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
        job = { id: `${scan.runId}:${id}`, createdAt: now(), queuedAt: queued, subscriberId: id, applicants, openings: [] };
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

type DeliveryScan = Pick<Scan, 'healthy' | 'sites' | 'groups'>;
type DeliveryCheck = { checkedAt: string; dates: Map<number, Set<string>> };

/** Proof comes only from successful observations in this run, never a Redis baseline. */
function deliveryChecks(scans: readonly DeliveryScan[]): Map<number, DeliveryCheck> {
  const checks = new Map<number, DeliveryCheck>();
  for (const scan of scans) {
    if (!scan.healthy) continue;
    for (const site of scan.sites) {
      if (!site.ok || !site.fetchedAt || !Number.isFinite(Date.parse(site.fetchedAt))) continue;
      checks.set(site.id, { checkedAt: site.fetchedAt, dates: new Map([[1, new Set(site.openDates)]]) });
    }
    for (const group of scan.groups) {
      if (group.ok) checks.get(group.siteId)?.dates.set(group.applicants, new Set(group.openDates));
    }
  }
  return checks;
}

/**
 * Notes, for the day's report, the limit in force when that day's counter is charged:
 * the highest of the day, which the report shows beside how many went out. The report
 * comes the next morning, when the setting may have changed. It is for the report only:
 * failing to write it must never hold an alert back.
 */
async function noteMailLimit(deps: CheckDeps, noted: Set<string>, day: string): Promise<void> {
  if (noted.has(day)) return;
  try {
    const before = await deps.kv.get(K.mailLimit(day));
    if (before === null || Number(before) < deps.mailDailyLimit) {
      await deps.kv.set(K.mailLimit(day), String(deps.mailDailyLimit), { ttlSeconds: STATS_KEEP_SECONDS });
    }
    noted.add(day); // only once it is there: a failure is tried again at the next charge
  } catch (err) {
    deps.log.warn("the day's email limit was not noted for the report", { err: err as Error });
  }
}

/** Send verified news within every cap. No current scan means no alert may go out. */
export async function deliver(
  deps: CheckDeps,
  now: () => number = deps.now ?? Date.now,
  /** People already emailed in this check; each is emailed once per check. */
  emailed: Set<string> = new Set(),
  /** Only scans from this invocation of runCheck; do not load these from stored history. */
  scans: readonly DeliveryScan[] = [],
): Promise<DeliveryReport> {
  const { kv, log } = deps;
  const report: DeliveryReport = { sent: 0, dryRun: 0, skipped: 0, failed: 0, dropped: 0, held: 0, remaining: 0, stoppedBy: null };
  const run = { failuresInARow: 0, emailed, checks: deliveryChecks(scans), limitNoted: new Set<string>() };
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
  run: { failuresInARow: number; emailed: Set<string>; checks: ReadonlyMap<number, DeliveryCheck>; limitNoted: Set<string> },
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
  const at = (deps.stampNow ?? (() => stampAt(now(), deps.uptime)))();
  // When each date was first queued: each is dropped on its own once older than
  // OUTBOX_MAX_AGE_MS. One whose age cannot be known (clock.ts) starts its 3 hours again now.
  const firstAt = new Map<string, Stamp>();
  for (const p of parts) {
    for (const o of p.openings) {
      for (const d of o.dates) {
        const key = dateKey(o.id, d);
        const stored = parseStamp(p.dateAt?.[key]) ?? p.queuedAt ?? { wall: p.createdAt };
        const when = elapsed(stored, at) === null ? at : stored;
        const seen = firstAt.get(key);
        if (!seen || elapsed(when, at)! > elapsed(seen, at)!) firstAt.set(key, when);
      }
    }
  }
  const young = (when: Stamp | undefined) => when !== undefined && elapsed(when, at)! <= OUTBOX_MAX_AGE_MS;
  const fresh = (siteId: number, date: string) => young(firstAt.get(dateKey(siteId, date)));
  for (const p of parts) if (!p.openings.some((o) => o.dates.some((d) => fresh(o.id, d)))) report.dropped++;
  if (![...firstAt.values()].some(young)) {
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
    const dateAt: Record<string, Stamp> = {};
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
      createdAt: Math.min(...Object.values(dateAt).map((w) => w.wall)),
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
  const found = parseStamp(lastRaw);
  const lastValue = found ? JSON.stringify(found) : null;
  // After a reboot this is the reboot's age, the least it can have been (clock.ts).
  const since = found === null ? Infinity : elapsed(found, at);
  if (since === null) {
    // How long ago cannot be known (written before stamps had boots): their gap starts again now.
    await kv.write([
      { op: 'set', key: K.lastAlert(id), value: JSON.stringify(at) },
      ...holdOps(jobOf(wanted)),
    ]);
    return 'next';
  }
  if (run.emailed.has(id) || since < PACE_SPACING_MS[sub.pace]) {
    await hold(deps, jobOf(wanted));
    return 'next';
  }
  // Only dates verified open in this run go out. One that closed while it
  // waited keeps waiting, until it is too old: if it opens again, they have
  // still not been told, and a date is announced to everyone once in 3 hours.
  const { open: openings, closed } = splitByOpen(run.checks, sub.applicants, wanted);
  const leftover = closed.length > 0 ? jobOf(closed) : null;
  if (openings.length === 0) {
    await hold(deps, jobOf(wanted));
    return 'next';
  }
  const next = jobOf(openings);

  const day = manilaDay(now());
  if (Number((await kv.get(K.alertsToday(id, day))) ?? 0) >= deps.alertsPerSubscriberPerDay) {
    report.skipped++;
    deps.stats?.count('alertsCapped', 1, day);
    await clearHeld(kv, id);
    return 'next';
  }
  await noteMailLimit(deps, run.limitNoted, day);
  if ((await kv.incr(K.mailSentToday(day), COUNTER_TTL_SECONDS)) > deps.mailDailyLimit) {
    // It all waits uncharged, closed dates too: the allowance is only spent on a send.
    await kv.write([{ op: 'decr', key: K.mailSentToday(day) }, ...holdOps(jobOf(wanted))]);
    report.stoppedBy = 'daily limit';
    deps.stats?.count('mailLimitHits', 1, day);
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
    { op: 'set', key: K.lastAlert(id), value: JSON.stringify(at) },
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
      deps.stats?.count('alertsSent', 1, day);
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
        lastValue === null
          ? { op: 'del', key: K.lastAlert(id) }
          : { op: 'set', key: K.lastAlert(id), value: lastValue },
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

/** Unknown, failed and closed dates wait; every applicant count needs current proof. */
function splitByOpen(checks: ReadonlyMap<number, DeliveryCheck>, applicants: number, openings: Opening[]) {
  const open: Opening[] = [];
  const closed: Opening[] = [];
  for (const o of openings) {
    const check = checks.get(o.id);
    const isOpen = (d: string) => check?.dates.get(1)?.has(d) === true && check.dates.get(applicants)?.has(d) === true;
    if (o.dates.some(isOpen)) open.push({ ...o, checkedAt: check!.checkedAt, dates: o.dates.filter(isOpen) });
    if (!o.dates.every(isOpen)) closed.push({ ...o, dates: o.dates.filter((d) => !isOpen(d)) });
  }
  return { open, closed };
}
