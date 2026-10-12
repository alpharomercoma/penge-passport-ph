// Clean-up (spec: "Lifetime and clean-up"), at the start of every checker run, under its lock, before the cooldown
// and health checks; also `admin.mjs device-cleanup` (the rollback's pre-step). Each step is a bounded script run
// until it has nothing left; each counts what it did.
import type { Stamp } from '../clock.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Logger } from '../log.ts';
import { aliveAlerts, collectGarbage, expireFanouts, LostLock, reclaimLocked, recount, sweep } from './scripts-delivery.ts';

export interface CleanupReport {
  expired: number;
  ended: number;
  deleted: number;
  garbage: number;
  recovered: number;
  uncertain: number;
  pruned: number;
  fanoutExpired: number;
  recount: { units: number; expectedUnits: number; alerts: number; expectedAlerts: number } | null;
}

const BATCH = 200;
const MAX_ROUNDS = 100;

export async function deviceCleanup(deps: { kv: Kv; log: Logger; now: () => number; stampNow: () => Stamp }, run: string): Promise<CleanupReport> {
  const { kv, log } = deps;
  const r: CleanupReport = { expired: 0, ended: 0, deleted: 0, garbage: 0, recovered: 0, uncertain: 0, pruned: 0, fanoutExpired: 0, recount: null };
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const x = await reclaimLocked(kv, { now: deps.now(), run, limit: BATCH });
    if (x.lost) throw new LostLock();
    r.expired += x.expired;
    r.ended += x.ended;
    r.deleted += x.deleted;
    if (x.expired + x.ended + x.deleted < BATCH) break;
  }
  const days = [manilaDay(deps.now()), manilaDay(deps.now() - 86_400_000), manilaDay(deps.now() - 2 * 86_400_000)];
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const g = await collectGarbage(kv, { now: deps.now(), run, limit: 50, days });
    if (g.lost) throw new LostLock();
    r.garbage += g.removed;
    if (g.left === 0) break;
  }
  const f = await expireFanouts(kv, { now: deps.now(), run, stamp: deps.stampNow() });
  if (f.lost) throw new LostLock();
  r.fanoutExpired = f.removed;
  const ids = await aliveAlerts(kv);
  for (let i = 0; i < ids.length; i += 50) {
    const s = await sweep(kv, { now: deps.now(), run, stamp: deps.stampNow(), ids: ids.slice(i, i + 50) });
    if (s.lost) throw new LostLock();
    r.recovered += s.recovered;
    r.uncertain += s.uncertain;
    r.pruned += s.pruned;
  }
  if (!(await kv.hGetAll(K.statsV2(manilaDay(deps.now())))).recounted) {
    r.recount = await recount(kv, deps.now(), run);
    if (r.recount.units !== r.recount.expectedUnits || r.recount.alerts !== r.recount.expectedAlerts) {
      log.error('notification storage units differ from a recount', r.recount);
    }
  }
  if (r.expired + r.ended + r.deleted + r.garbage + r.recovered + r.uncertain + r.pruned > 0) log.info('notification clean-up', { run, ...r, recount: undefined });
  return r;
}
