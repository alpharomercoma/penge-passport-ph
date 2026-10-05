// The day's numbers, counted on the server: no script in the page, no cookie,
// and no visitor's address kept. A visitor is a hash of their network address
// and browser (user agent) with a random salt for the Manila day, added to a
// HyperLogLog, which keeps an estimate of how many distinct hashes it was
// given, not the hashes. The salt is deleted within 25 hours, its copy in
// Valkey's log included (deploy/valkey-compact.sh); after that nobody,
// us included, can tell whether some address visited.
//
// Once a day, after REPORT_HOUR in Manila, the checker writes yesterday's
// numbers to R2 and emails them to the operator (STATS_EMAIL).
import { createHash, randomBytes } from 'node:crypto';
import { describePost, type SiteSummary } from '@penge/contracts';
import { catalogPosts } from './abroad.ts';
import { K, manilaDay } from './keys.ts';
import type { Kv } from './kv.ts';
import type { Logger } from './log.ts';
import { type Mailer, wasRefused } from './mailer.ts';
import type { SnapshotSink } from './r2.ts';
import { dailyStatsEmail } from './templates.ts';

/** How long a day's numbers stay in Redis: long enough for a late report. */
export const STATS_KEEP_SECONDS = 40 * 24 * 3600;
/**
 * A salt lasts at least to the end of its day, and never a whole day beyond it.
 * Valkey's log keeps it up to an hour more, until the hourly rewrite: 25 hours
 * in all, as the privacy page says.
 */
export const SALT_SECONDS = 24 * 3600;
/** After this hour, Manila time, the checker reports the day before. */
export const REPORT_HOUR = 7;

export const COUNTS = [
  'officeViews',
  'groupChecks',
  'hourLookups',
  'confirmEmails',
  'confirmed',
  'updated',
  'unsubscribed',
  'alertsSent',
  'alertsCapped',
  'mailLimitHits',
  'runs',
  'healthyRuns',
  'datesOpened',
  'pushAccepted',
  'pushRefused',
  'pushUncertain',
  'pushGone',
  'pushDevicesRemoved',
] as const;
export type Count = (typeof COUNTS)[number];

/** Crawlers, link previews, monitors and scripts: not people. */
const NOT_A_PERSON =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|monitor|headless|curl|wget|python|go-http|java\/|okhttp|node|axios|undici|libwww|httpie|postman/i;

export function isPerson(userAgent: string | undefined): boolean {
  return !!userAgent && userAgent.length <= 512 && !NOT_A_PERSON.test(userAgent);
}

export interface Stats {
  /** A visit to the site, from a person; `abroad` when they looked at the posts abroad. */
  visit(address: string, userAgent: string | undefined, opts?: { abroad?: boolean }): void;
  /** An office opened by a person. */
  officeView(siteId: number, userAgent: string | undefined): void;
  /** `day` is the Manila day it belongs to, when that is not the moment the write happens (a charge made just before midnight). */
  count(name: Count, by?: number, day?: string): void;
  /** Resolves once everything counted so far is written. */
  settled(): Promise<void>;
}

/**
 * Counting never delays or breaks what it counts: each write happens after
 * the call returns, and a failed one is logged and forgotten.
 */
export function createStats(kv: Kv, log: Logger, now: () => number = Date.now): Stats {
  const pending = new Set<Promise<void>>();
  let sinceMarked = false;

  const later = (work: () => Promise<unknown>) => {
    const p: Promise<void> = work()
      .then(
        () => undefined,
        (err: unknown) => log.warn('a daily number was not counted', { err: err as Error }),
      )
      .finally(() => pending.delete(p));
    pending.add(p);
  };

  const markSince = async () => {
    if (sinceMarked) return;
    await kv.set(K.statsSince, new Date(now()).toISOString(), { nx: true });
    sinceMarked = true;
  };

  // Read from Redis on every visit and never kept in memory: when Redis expires
  // the salt, no copy of it is left anywhere.
  const saltFor = async (day: string) => {
    await kv.set(K.statSalt(day), randomBytes(32).toString('base64url'), { nx: true, ttlSeconds: SALT_SECONDS });
    const stored = await kv.get(K.statSalt(day));
    if (!stored) throw new Error('the day has no salt');
    return stored;
  };

  return {
    visit(address, userAgent, opts = {}) {
      if (!isPerson(userAgent)) return;
      later(async () => {
        const day = manilaDay(now());
        const id = createHash('sha256').update(`${await saltFor(day)}\n${address}\n${userAgent}`).digest('base64url');
        await kv.pfAdd(K.stat(day, 'visitors'), id, STATS_KEEP_SECONDS);
        if (opts.abroad) await kv.pfAdd(K.stat(day, 'abroadVisitors'), id, STATS_KEEP_SECONDS);
        await markSince();
      });
    },
    officeView(siteId, userAgent) {
      if (!isPerson(userAgent)) return;
      later(async () => {
        const day = manilaDay(now());
        await kv.incr(K.stat(day, 'officeViews'), STATS_KEEP_SECONDS);
        await kv.hIncr(K.statOffices(day), String(siteId), STATS_KEEP_SECONDS);
        await markSince();
      });
    },
    count(name, by = 1, day) {
      if (by <= 0) return;
      later(async () => {
        await kv.incr(K.stat(day ?? manilaDay(now()), name), STATS_KEEP_SECONDS, by);
        await markSince();
      });
    },
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

export interface DailyStats {
  schema: 1;
  /** The Manila day, YYYY-MM-DD. */
  day: string;
  /** Counting began part-way through the day, at this time: the numbers before it are missing. */
  partialFrom: string | null;
  /** Estimated distinct visitors (network and browser), and how many of them looked abroad. */
  visitors: number;
  abroadVisitors: number;
  counts: Record<Count, number>;
  /** The offices opened most that day. */
  topOffices: { id: number; name: string; views: number }[];
  /** The highest site-wide limit on alerts (MAIL_DAILY_LIMIT) in force when that day's alerts were charged; null if none were. */
  mailLimit: number | null;
  /** When the report was made, not at the end of the day. */
  subscribers: number;
  generatedAt: string;
}

async function siteNames(kv: Kv): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const raw = await kv.get(K.sites);
  for (const s of raw ? (JSON.parse(raw) as SiteSummary[]) : []) names.set(s.id, s.name);
  for (const p of await catalogPosts(kv)) {
    const d = describePost(p.name, p.country);
    names.set(p.id, `${d.place} (${d.detail})`);
  }
  return names;
}

export async function dailyStats(kv: Kv, day: string, now: number): Promise<DailyStats> {
  const counts = {} as Record<Count, number>;
  for (const name of COUNTS) counts[name] = Number((await kv.get(K.stat(day, name))) ?? 0);
  const names = await siteNames(kv);
  const topOffices = Object.entries(await kv.hGetAll(K.statOffices(day)))
    .map(([id, views]) => ({ id: Number(id), name: names.get(Number(id)) ?? `Office ${id}`, views: Number(views) }))
    .sort((a, b) => b.views - a.views || a.id - b.id)
    .slice(0, 5);
  const since = await kv.get(K.statsSince);
  const limit = await kv.get(K.mailLimit(day));
  return {
    schema: 1,
    day,
    partialFrom: since && manilaDay(Date.parse(since)) === day ? since : null,
    visitors: await kv.pfCount(K.stat(day, 'visitors')),
    abroadVisitors: await kv.pfCount(K.stat(day, 'abroadVisitors')),
    counts,
    topOffices,
    mailLimit: limit !== null && Number.isFinite(Number(limit)) ? Number(limit) : null,
    subscribers: (await kv.sMembers(K.allSubscribers)).length,
    generatedAt: new Date(now).toISOString(),
  };
}

/** `stats/v1/date=2026-09-27/stats.json`, beside the scans for DuckDB. */
export const statsKey = (day: string) => `stats/v1/date=${day}/stats.json`;

export interface ReportDeps {
  kv: Kv;
  sink: SnapshotSink;
  mailer: Mailer;
  log: Logger;
  /** Who gets the daily email; without it the numbers only go to R2. */
  statsEmail?: string | null;
}

/**
 * Yesterday's numbers to R2 and to the operator's inbox, each once. R2 retries
 * on the next run after a failure; so does an email the mail server refused,
 * but not one that may already have gone out.
 */
export async function reportOncePerDay(deps: ReportDeps, now: number): Promise<void> {
  const { kv, sink, mailer, log } = deps;
  if (new Date(now + 8 * 3600_000).getUTCHours() < REPORT_HOUR) return;
  const day = manilaDay(now - 86_400_000);
  const since = await kv.get(K.statsSince);
  if (!since || manilaDay(Date.parse(since)) > day) return; // nothing was counted that day
  let numbers: DailyStats | null = null;
  const stats = async () => (numbers ??= await dailyStats(kv, day, now));

  if (sink.putObject && !(await kv.get(K.statsStored(day)))) {
    try {
      await sink.putObject(statsKey(day), new TextEncoder().encode(JSON.stringify(await stats())), 'application/json');
      await kv.set(K.statsStored(day), '1', { ttlSeconds: STATS_KEEP_SECONDS });
      log.info('daily numbers stored', { day });
    } catch (err) {
      log.error('daily numbers not stored; the next run retries', { day, err: err as Error });
    }
  }

  if (deps.statsEmail && (await kv.set(K.statsEmailed(day), '1', { nx: true, ttlSeconds: STATS_KEEP_SECONDS }))) {
    try {
      await mailer.send({ ...dailyStatsEmail(await stats()), to: deps.statsEmail, kind: 'report' });
      log.info('daily numbers emailed', { day });
    } catch (err) {
      if (wasRefused(err)) await kv.write([{ op: 'del', key: K.statsEmailed(day) }]);
      log.error('daily numbers email failed', { day, retries: wasRefused(err), err: err as Error });
    }
  }
}
