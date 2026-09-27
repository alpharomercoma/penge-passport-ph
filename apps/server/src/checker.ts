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
//  6. Caps: alerts per subscriber per day, and emails per day in total.
//  7. Alerts older than an hour are dropped: stale news is noise.
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
import { officeMapUrl, officePhone, type SiteStatus, type StatusResponse } from '@penge/contracts';
import { unsubscribeLinks } from './api.ts';
import { exportSubscribers } from './backup.ts';
import { K, manilaDay } from './keys.ts';
import type { Kv, WriteOp } from './kv.ts';
import type { Logger } from './log.ts';
import { type Mailer, wasRefused } from './mailer.ts';
import type { SnapshotSink } from './r2.ts';
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
  sink: SnapshotSink;
  mailer: Mailer;
  keys: Keys;
  log: Logger;
  publicBaseUrl: string;
  mailDailyLimit: number;
  alertsPerSubscriberPerDay: number;
  /** Recorded in each scan, e.g. "penge-passport-ph@0.1.0". */
  client: string;
  now?: () => number;
  runId?: string;
}

export const ANNOUNCE_WINDOW_SECONDS = 3 * 3600;
export const OUTBOX_MAX_AGE_MS = 60 * 60_000;
/** Extra lookups per run for group sizes; each is one more request to the site (budget.ts has the sum). */
export const GROUP_QUERY_CAP = 10;
/** Offices that answered with an error are tried once more, this many at most per run. */
export const RETRY_CAP = 3;
/**
 * A scan that still has this many offices answering with errors (after the
 * retries), or that the rate limiter paused, makes the next scans wait
 * COOLDOWN_SECONDS: a struggling site is asked every 15 minutes, not every 5.
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
  attempts?: number;
}

export interface DeliveryReport {
  sent: number;
  dryRun: number;
  skipped: number;
  failed: number;
  dropped: number;
  remaining: number;
  stoppedBy: 'paused' | 'daily limit' | 'mail errors' | null;
}

export interface RunReport {
  runId: string;
  skipped: 'locked' | 'cooling down' | null;
  healthy: boolean;
  problems: string[];
  uploaded: boolean;
  queued: number;
  delivery: DeliveryReport | null;
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
  const runId = deps.runId ?? newRunId(now());

  if (await kv.get(K.scanCooldown)) {
    log.info('the site had trouble on a recent scan; resting before the next', { runId });
    return { runId, skipped: 'cooling down', healthy: false, problems: [], uploaded: false, queued: 0, delivery: null };
  }
  if (!(await kv.set(K.checkLock, runId, { nx: true, ttlSeconds: LOCK_TTL_SECONDS }))) {
    log.warn('another check is running; skipping this one', { runId });
    return { runId, skipped: 'locked', healthy: false, problems: [], uploaded: false, queued: 0, delivery: null };
  }
  try {
    const holdLock = async () => {
      if ((await kv.get(K.checkLock)) !== runId) throw new Error('lost the checker lock; stopping this run');
      await kv.set(K.checkLock, runId, { ttlSeconds: LOCK_TTL_SECONDS });
    };
    const loadSubscriber = subscriberCache(kv);
    const scan = await scanAll(deps, runId, now, loadSubscriber, holdLock);
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
    const delivery = await deliver(deps, now);
    await backupOncePerDay(deps, now, runId);
    return { runId, skipped: null, healthy: scan.healthy, problems: scan.problems, uploaded, queued, delivery };
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
  const groups = healthy && !circuitOpen ? await scanGroups(deps, sites, loadSubscriber) : [];
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
async function scanGroups(deps: CheckDeps, sites: SiteObservation[], loadSubscriber: LoadSubscriber) {
  const groups: GroupObservation[] = [];
  let budget = GROUP_QUERY_CAP;
  let stop: string | null = null;
  for (const site of sites) {
    if (!site.ok || site.openDates.length === 0) continue;
    const sizes = new Set<number>();
    for (const id of await deps.kv.sMembers(K.siteSubscribers(site.id))) {
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
        skip(`skipped: more than ${GROUP_QUERY_CAP} group lookups this run`);
        continue;
      }
      try {
        const a = await deps.upstream.availability({ siteId: site.id, applicants });
        groups.push({ siteId: site.id, applicants, ok: true, error: null, openDates: [...a.availableDates].sort() });
      } catch (err) {
        skip(message(err));
        if (err instanceof CircuitOpenError) stop = 'skipped: the rate limiter paused requests';
      }
    }
  }
  return groups;
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

/** Send what is in the outbox, within every cap. */
export async function deliver(deps: CheckDeps, now: () => number = deps.now ?? Date.now): Promise<DeliveryReport> {
  const { kv, log, mailer } = deps;
  const report: DeliveryReport = { sent: 0, dryRun: 0, skipped: 0, failed: 0, dropped: 0, remaining: 0, stoppedBy: null };

  let failuresInARow = 0;
  for (let i = 0; i < 5000; i++) {
    // Checked before every email, so a pause takes effect mid-run.
    if (await kv.get(K.mailPaused)) {
      report.stoppedBy = 'paused';
      log.warn('mail is paused; the outbox waits');
      break;
    }
    const raw = await kv.lPop(K.outbox);
    if (raw === null) break;
    const job = openJob(raw, deps.keys.token);
    if (!job) {
      report.dropped++;
      log.warn('dropped an outbox entry with a bad signature');
      continue;
    }
    if (now() - job.createdAt > OUTBOX_MAX_AGE_MS) {
      report.dropped++;
      continue;
    }
    const sub = await load(kv, job.subscriberId);
    if (!sub) {
      report.skipped++;
      continue;
    }
    // The subscriber may have changed their offices or group size since this was queued.
    const openings = job.openings.filter((o) => sub.siteIds.includes(o.id));
    if (sub.applicants !== job.applicants || openings.length === 0) {
      report.skipped++;
      continue;
    }
    const day = manilaDay(now());
    if (Number((await kv.get(K.alertsToday(sub.id, day))) ?? 0) >= deps.alertsPerSubscriberPerDay) {
      report.skipped++;
      continue;
    }
    if ((await kv.incr(K.mailSentToday(day), COUNTER_TTL_SECONDS)) > deps.mailDailyLimit) {
      // Put it back uncharged: the subscriber's own allowance is only spent on a send.
      await kv.write([{ op: 'rPush', key: K.outbox, values: [raw] }]);
      report.stoppedBy = 'daily limit';
      log.warn('daily email limit reached; the outbox waits', { limit: deps.mailDailyLimit });
      break;
    }
    const todays = await kv.incr(K.alertsToday(sub.id, day), COUNTER_TTL_SECONDS);

    const links = unsubscribeLinks(deps.publicBaseUrl, sub.id, deps.keys);
    const content = alertEmail({
      openings,
      applicants: job.applicants,
      unsubscribeUrl: links.page,
      manageUrl: `${deps.publicBaseUrl}/`,
      lastToday: todays === deps.alertsPerSubscriberPerDay,
    });
    try {
      const result = await mailer.send({ ...content, to: emailOf(sub, deps.keys), kind: 'alert', unsubscribeUrl: links.oneClick });
      if (result === 'sent') report.sent++;
      else if (result === 'dry-run') report.dryRun++;
      else report.skipped++;
      failuresInARow = 0;
    } catch (err) {
      report.failed++;
      failuresInARow++;
      if (wasRefused(err)) {
        // Nothing was sent: neither today's total nor the subscriber's
        // allowance is charged, and it is tried again later.
        await kv.decr(K.mailSentToday(day));
        await kv.decr(K.alertsToday(sub.id, day));
        log.error('alert email refused', { job: job.id, err: err as Error });
        const attempts = (job.attempts ?? 0) + 1;
        if (attempts < MAX_MAIL_ATTEMPTS) {
          await kv.write([{ op: 'rPush', key: K.outbox, values: [sealJob({ ...job, attempts }, deps.keys.token)] }]);
        }
      } else {
        // It may have gone out: it stays charged, and is not sent again, which
        // could make a duplicate.
        log.error('alert email may or may not have gone out; not sending it again', { job: job.id, err: err as Error });
      }
      if (failuresInARow >= 3) {
        report.stoppedBy = 'mail errors';
        break;
      }
    }
  }
  report.remaining = await kv.lLen(K.outbox);
  return report;
}
