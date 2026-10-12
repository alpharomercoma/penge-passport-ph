// Every notification counter (spec: "Reporting"), its unit, and the transition that increments it, inside the
// atomic step that makes the change (so a retry or a crash cannot count twice). devices-counters.test.ts checks this
// list against every count() in the scripts, both ways.
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { deviceScript } from './lua.ts';

type Unit = 'requests' | 'operations' | 'alerts' | 'dates' | 'claims' | 'batches' | 'entries' | 'records' | 'runs' | 'pushes';

export const DEVICE_COUNTERS: { name: string; unit: Unit; when: string }[] = [
  { name: 'requests_refused_*', unit: 'requests', when: 'a request refused by a pool, by the pool that refused (charge)' },
  { name: 'requests_refused_mode', unit: 'requests', when: 'a setup refused because the mode does not allow it (off, unavailable)' },
  { name: 'requests_refused_owner', unit: 'requests', when: 'a first setup refused in owner mode without the right token' },
  { name: 'requests_refused_endpoint', unit: 'requests', when: 'a setup refused because its subscription failed the endpoint checks' },
  { name: 'requests_refused_memory', unit: 'requests', when: 'a setup refused because Valkey was above 70% of its memory' },
  { name: 'refused_*', unit: 'requests', when: 'an admission refused by the script: busy, invalid, changed, full, limited' },
  { name: 'ops_started', unit: 'operations', when: 'a setup, rotation or change stored for the first time (its op)' },
  { name: 'ops_*', unit: 'operations', when: 'an operation ended with this result: active, expired, changed, full, owner-only, gone, failed, off' },
  { name: 'dispatch_*', unit: 'pushes', when: 'a setup push settled: accepted, uncertain, retryable, failed, gone' },
  { name: 'dispatch_held_*', unit: 'pushes', when: 'a setup push held at its gate: mode, paused, backoff, limited' },
  { name: 'acks', unit: 'requests', when: 'an acknowledgement reached the atomic step (counted toward the 10 per operation)' },
  { name: 'alerts_created', unit: 'alerts', when: 'an activation created an alert (a new incarnation)' },
  { name: 'alerts_changed', unit: 'alerts', when: 'a setup with a captured alert replaced its choices' },
  { name: 'alerts_*', unit: 'alerts', when: 'an alert deleted: ended, gone, off (turned off), replaced' },
  { name: 'rotations_completed', unit: 'alerts', when: 'a rotation activated a new subscription' },
  { name: 'changes_applied', unit: 'operations', when: 'a change applied (revision + 1)' },
  { name: 'changes_refused', unit: 'operations', when: 'a change refused with 409 (incarnation or revision not current)' },
  { name: 'renewals', unit: 'requests', when: 'a renewal on opening reached the script with an active alert' },
  { name: 'gone_kept', unit: 'alerts', when: 'a gone report kept an alert because a rotation is pending (goneGeneration set)' },
  { name: 'fanout_batches', unit: 'batches', when: 'a fan-out batch stored with the first queueing write' },
  { name: 'fanout_dropped_batches', unit: 'batches', when: 'a fan-out batch not stored because 5 were pending' },
  { name: 'fanout_dropped_entries', unit: 'entries', when: 'the entries of a batch not stored because 5 were pending' },
  { name: 'fanout_merged', unit: 'alerts', when: 'jobs written by a chunk of the second queueing write' },
  { name: 'fanout_skipped_*', unit: 'batches', when: 'a fan-out batch left out of the first queueing write (counted by that write): size (over 2,000 entries), memory (used_memory above 85%), failed (the write failed with it and was written again without it)' },
  { name: 'fanout_skipped_entries', unit: 'entries', when: 'the entries of a batch left out for any of the three reasons above' },
  { name: 'fanout_second_failures', unit: 'runs', when: 'a run whose second queueing write failed (the batch stays for the next run)' },
  { name: 'dates_dropped_overflow', unit: 'dates', when: 'dates dropped to keep a job within 30 dates and 4 KB' },
  { name: 'dates_dropped_choices', unit: 'dates', when: 'dates dropped because the alert no longer follows that office and group, or has another incarnation' },
  { name: 'dates_dropped_window', unit: 'dates', when: 'dates dropped past their 3-hour window' },
  { name: 'dates_dropped_unknown_age', unit: 'dates', when: 'dates dropped because their age cannot be known (another boot)' },
  { name: 'dates_dropped_tries', unit: 'dates', when: 'dates dropped after 3 refused tries' },
  { name: 'dates_held_cap', unit: 'dates', when: 'dates held because the alert reached its daily cap' },
  { name: 'claims', unit: 'claims', when: 'a claim made' },
  { name: 'claims_refused_*', unit: 'claims', when: 'a claim refused: none, ended, claimed, attempted, empty, deferred, unverified, pace, cap' },
  { name: 'claims_*', unit: 'claims', when: 'a claim settled: accepted, uncertain, bug, gone, refused (put back after an attempt), unattempted, recovered, recovered_uncertain' },
  { name: 'garbage_removed', unit: 'alerts', when: 'a deleted alert\'s delivery keys removed and its units released' },
  { name: 'fanout_expired', unit: 'batches', when: 'a fan-out batch past its 3-hour window removed by clean-up' },
  { name: 'tests_*', unit: 'pushes', when: 'a test notification sent, by its result: accepted, uncertain, refused, gone (counted by the route after the send)' },
  { name: 'recount_differences', unit: 'runs', when: 'the daily recount found units or alerts different from those kept' },
  { name: 'cleanup_failures', unit: 'runs', when: 'a run\'s notification clean-up failed (its notification pass was skipped)' },
];

const countScript = deviceScript('dev-count', `count(A.name, A.by) return '"ok"'`);

// Telemetry made outside a script never holds up the work it describes: it is started and left to finish on its own;
// flushCounts gives what is still running a bounded time at the end of a run (a Valkey that stopped answering costs
// the run that much and no more).
const pending = new Set<Promise<void>>();
/** Past this many still waiting (a Valkey that stopped answering, run after run), new telemetry is dropped. */
const MAX_PENDING = 50;
export const pendingCount = () => pending.size;
export function later(start: () => Promise<unknown>): void {
  // Checked before the work starts, so past the cap nothing more is started at all.
  if (pending.size >= MAX_PENDING) return;
  let p: Promise<unknown>;
  try {
    p = start();
  } catch {
    return;
  }
  const settled: Promise<void> = p.then(
    () => {},
    () => {},
  );
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
}
/** The value, or the fallback once `ms` have passed without one (a rejection gives the fallback too). */
export async function withDeadline<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<F>((r) => (timer = setTimeout(() => r(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function flushCounts(ms: number): Promise<void> {
  if (pending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled([...pending]), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

/** A count made outside a script (a route's own refusal, a failed clean-up), into the same day's v2 hash. */
export async function countDevice(kv: Kv, now: number, name: string, by = 1): Promise<void> {
  await countScript.run(kv, { stats: K.statsV2(manilaDay(now)) }, { now, name, by });
}

export interface DeviceGauges {
  readAt: string;
  alertsActive: number;
  setupsUnfinished: number;
  alerts: number;
  alertLimit: number;
  units: number;
  recordLimit: number;
  flags: string[];
  persistence: { rdbLastOk: string | null; rdbStatus: string | null; aofOkAfter: string | null; aofOkBy: string | null; aofRewriteStatus: string | null };
}

const gaugeScript = deviceScript(
  'dev-gauges',
  `need(KEY.ends, 'zset') need(KEY.ops, 'zset') need(KEY.records, 'hash')
return cjson.encode({ active = redis.call('ZCOUNT', KEY.ends, '(' .. I(NOW), '+inf'), ops = redis.call('ZCARD', KEY.ops),
  units = tonumber(redis.call('HGET', KEY.records, 'units') or '0'), alerts = tonumber(redis.call('HGET', KEY.records, 'alerts') or '0') })`,
  { reclaim: true },
);

export async function deviceGauges(kv: Kv, now: number, limits: { alertLimit: number; recordLimit: number }): Promise<DeviceGauges> {
  const g = await gaugeScript.run<{ active: number; ops: number; units: number; alerts: number }>(kv, {}, { now });
  const p = await kv.persistence();
  const noted = await kv.hGetAll(K.persist);
  const flags: string[] = [];
  const stale = (ms: number | null) => ms === null || now - ms > 2 * 3600_000;
  // rdb_last_save_time is the last successful save whatever the latest attempt did; the status is the latest attempt's.
  if (p.rdbStatus !== null && stale(p.rdbLastSave ? p.rdbLastSave * 1000 : null)) flags.push('no successful snapshot in 2 hours: deleted data may stay in dump.rdb longer');
  if (p.rdbStatus !== null && p.rdbStatus !== 'ok') flags.push(`the latest snapshot attempt failed (${p.rdbStatus})`);
  if (p.aofRewriteStatus !== null && p.aofRewriteStatus !== 'ok') flags.push(`the latest append-only rewrite failed (${p.aofRewriteStatus})`);
  if (p.aofRewriteStatus !== null && stale(noted.aofOkBy ? Number(noted.aofOkBy) : null)) flags.push('no append-only rewrite known to have finished in 2 hours: deleted data may stay in the AOF longer');
  const share = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
  if (limits.alertLimit > 0 && g.alerts >= 0.8 * limits.alertLimit) flags.push(`alerts at ${share(g.alerts, limits.alertLimit)}% of DEVICE_ALERT_LIMIT`);
  if (limits.recordLimit > 0 && g.units >= 0.8 * limits.recordLimit) flags.push(`records at ${share(g.units, limits.recordLimit)}% of DEVICE_RECORD_LIMIT`);
  return {
    readAt: new Date(now).toISOString(),
    alertsActive: g.active,
    setupsUnfinished: g.ops,
    alerts: g.alerts,
    alertLimit: limits.alertLimit,
    units: g.units,
    recordLimit: limits.recordLimit,
    flags,
    persistence: {
      rdbLastOk: p.rdbLastSave ? new Date(p.rdbLastSave * 1000).toISOString() : null,
      rdbStatus: p.rdbStatus,
      aofOkAfter: noted.aofOkAfter ? new Date(Number(noted.aofOkAfter)).toISOString() : null,
      aofOkBy: noted.aofOkBy ? new Date(Number(noted.aofOkBy)).toISOString() : null,
      aofRewriteStatus: p.aofRewriteStatus,
    },
  };
}

/**
 * Valkey says when the last snapshot succeeded, but not when the last append-only rewrite did: runs bracket it. Only a
 * reading with no rewrite in progress counts; between two such readings, a grown count means a rewrite started after the
 * first and finished before the second.
 */
export async function notePersistence(kv: Kv, clock: number | (() => number)): Promise<void> {
  const time = typeof clock === 'number' ? () => clock : clock;
  // The reading happens somewhere between these two times: idle "at" the first (a later rewrite started after it), and
  // a finished rewrite finished "by" the second.
  const before = time();
  const p = await kv.persistence();
  const after = time();
  if (p.aofRewrites === null || p.aofInProgress !== 0) return;
  const healthy = p.aofRewriteStatus === 'ok' && (p.aofFailures ?? 0) === 0;
  await persistScript.run(kv, { persist: K.persist }, { now: after, before, after, rewrites: p.aofRewrites, healthy });
}

// The bracket, compared and set in one step: a reading older than the one stored (a run that outlived its own, its
// INFO answered late) changes nothing.
const persistScript = deviceScript(
  'dev-persist',
  `need(K.persist, 'hash')
local idle = tonumber(redis.call('HGET', K.persist, 'aofIdleAt') or '')
if idle ~= nil and idle >= A.before then return '"stale"' end
local prev = tonumber(redis.call('HGET', K.persist, 'aofRewrites') or '')
redis.call('HSET', K.persist, 'aofRewrites', I(A.rewrites), 'aofIdleAt', I(A.before))
if prev ~= nil and idle ~= nil and A.rewrites > prev and A.healthy then
  redis.call('HSET', K.persist, 'aofOkAfter', I(idle), 'aofOkBy', I(A.after))
end
return '"ok"'`,
  { reclaim: true },
);
