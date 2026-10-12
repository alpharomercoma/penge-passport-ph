// Queueing for notification alerts (spec: "Headroom", "Queueing is two writes"). The first write is the email
// write plus a fan-out batch; if it fails with the batch, it is retried once without it (the notification work
// dropped and counted). The second write turns batches into merged jobs, in chunks, within a time budget.
import type { Stamp } from '../clock.ts';
import { K } from '../keys.ts';
import type { Kv, WriteOp } from '../kv.ts';
import type { Logger } from '../log.ts';
import { fanoutChunk, LostLock, queueWrite } from './scripts-delivery.ts';

export const FANOUT_MAX_ENTRIES = 2000;
export const FANOUT_MAX_PENDING = 5;
export const CHUNK_ENTRIES = 100;
/** Recipients merged per chunk at most: measured on Valkey (devices-footprint.test.ts), merging into full jobs at the alert
 * ceiling, about 33 ms (200 took 60 ms): under the 50 ms a chunk may take. */
export const CHUNK_WORK = 100;
export const FANOUT_BUDGET_MS = 10_000;
/** Above this share of maxmemory, the first write goes without its batch. */
export const MEMORY_SKIP = 0.85;

/** One entry per office, date and group size some notification alert follows: "<office>|<date>|<group>|0". */
export async function fanoutEntries(kv: Kv, openings: { siteId: number; applicants: number; dates: string[] }[]): Promise<string[]> {
  const followed = new Map<number, Set<string>>();
  const entries: string[] = [];
  for (const o of openings) {
    let groups = followed.get(o.siteId);
    if (!groups) {
      groups = new Set((await kv.sMembers(K.devSite(o.siteId))).map((m) => m.slice(m.lastIndexOf(':') + 1)));
      followed.set(o.siteId, groups);
    }
    if (!groups.has(String(o.applicants))) continue;
    for (const date of o.dates) entries.push(`${o.siteId}|${date}|${o.applicants}|0`);
  }
  return entries;
}

export async function writeQueue(
  deps: { kv: Kv; log: Logger; now: () => number; stats?: { count(name: string, by?: number): void } },
  a: { run: string; ops: WriteOp[]; batchId: string; stamp: Stamp; openings: { siteId: number; applicants: number; dates: string[] }[] },
): Promise<void> {
  const { kv, log } = deps;
  let entries: string[] = [];
  try {
    entries = await fanoutEntries(kv, a.openings);
  } catch (err) {
    log.warn('notification fan-out not computed; email goes on', { run: a.run, err: err as Error });
  }
  let batch = entries.length > 0 ? { id: a.batchId, entries, stamps: [a.stamp] } : null;
  // Why the notification work was left out, counted once the email work it rode with is written.
  let skipped: 'size' | 'memory' | 'failed' | null = null;
  if (batch && entries.length > FANOUT_MAX_ENTRIES) {
    log.warn('notification fan-out too large; dropped', { run: a.run, entries: entries.length });
    batch = null;
    skipped = 'size';
  }
  if (batch) {
    const mem = await kv.memory().catch(() => ({ used: 0, max: 0 }));
    if (mem.max > 0 && mem.used / mem.max > MEMORY_SKIP) {
      log.warn('memory above 85%: notification fan-out dropped', { run: a.run, entries: entries.length });
      batch = null;
      skipped = 'memory';
    }
  }
  // What was left out is counted by the queueing script itself, under its mark: a retry of the same write counts nothing again.
  const left = (reason: 'size' | 'memory' | 'failed' | null) => (reason ? { reason, entries: entries.length } : null);
  try {
    await queueWrite(kv, { now: deps.now(), run: a.run, mark: a.batchId, ops: a.ops, batch, skipped: left(skipped) });
  } catch (err) {
    if (err instanceof LostLock || !batch) throw err;
    log.error('queueing with the notification fan-out failed; retrying without it', { run: a.run, entries: entries.length, err: err as Error });
    await queueWrite(kv, { now: deps.now(), run: a.run, mark: a.batchId, ops: a.ops, batch: null, skipped: left('failed') });
  }
}

/** The second write: pending batches, oldest first, chunk by chunk, until done or `until`. Yields between chunks. */
export async function writeFanout(deps: { kv: Kv; now: () => number }, a: { run: string; until: number }): Promise<{ chunks: number; merged: number }> {
  let chunks = 0;
  let merged = 0;
  while (deps.now() < a.until) {
    const r = await fanoutChunk(deps.kv, { now: deps.now(), run: a.run, maxEntries: CHUNK_ENTRIES, maxWork: CHUNK_WORK });
    if (r.lost) throw new LostLock();
    if (r.done) break;
    chunks++;
    merged += r.work ?? 0;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { chunks, merged };
}
