// The notification pass (spec: "Sending"): the second queueing write for pending fan-out batches (10 s of it per
// run), then the domestic batch, then, once the abroad scan says it is ready (always, even empty), the abroad fan-out
// and batch. Each batch has 60 s of sending from its first send; a slot is taken before each claim; at most 8 sends at
// once. Nothing here can stop or delay the scans or the email pass, and an error ends only this pass.
import type { Opening } from '../templates.ts';
import { type PushMode, describePost } from '@penge/contracts';
import { catalogPosts } from '../abroad.ts';
import type { Stamp } from '../clock.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Logger } from '../log.ts';
import { buildPayload } from '../push/payload.ts';
import type { Keys } from '../subscribers.ts';
import { countDevice, later } from './counters.ts';
import { writeFanout, FANOUT_BUDGET_MS } from './queue.ts';
import { claim, LostLock, sendGate, setCursor, settle, workList } from './scripts-delivery.ts';
import { checkPushSubscription } from '../push/endpoint.ts';
import { openSubscription } from './store.ts';
import { CHECKER_SLOTS, loggable, type SendResult, SendSlots, type Transport } from './transport.ts';
import { newId } from '../crypto.ts';

export const BATCH_SENDING_MS = 60_000;
const ALERT_TTL_SECONDS = 1800;

export interface DeliveryCheckLike {
  checkedAt: string;
  dates: Map<number, Set<string>>;
  times: Map<number, string>;
}

export interface PassDeps {
  kv: Kv;
  keys: Keys;
  log: Logger;
  now: () => number;
  stampNow: () => Stamp;
  mode: PushMode;
  transport: Transport | null;
  alertsPerDay: number;
  /** deliveryChecks() of the checker, for the scans given. */
  checks: (scans: readonly unknown[]) => Map<number, DeliveryCheckLike>;
}

export interface BatchReport {
  considered: number;
  claimed: number;
  accepted: number;
  refused: number;
  uncertain: number;
  gone: number;
  stoppedBy: 'paused' | 'rejected' | 'deadline' | 'mode' | null;
}
export interface DevicePassReport {
  fanout: { chunks: number; merged: number };
  domestic: BatchReport;
  abroad: BatchReport;
}

const emptyBatch = (): BatchReport => ({ considered: 0, claimed: 0, accepted: 0, refused: 0, uncertain: 0, gone: 0, stoppedBy: null });

export async function notificationPass(deps: PassDeps, ctx: { run: string; scan: unknown; abroadReady: Promise<unknown | null> }): Promise<DevicePassReport> {
  const { kv, log } = deps;
  const report: DevicePassReport = { fanout: { chunks: 0, merged: 0 }, domestic: emptyBatch(), abroad: emptyBatch() };
  let fanoutLeft = FANOUT_BUDGET_MS;
  let secondFailed = false;
  const fanout = async () => {
    const started = deps.now();
    try {
      const r = await writeFanout(deps, { run: ctx.run, until: started + fanoutLeft });
      report.fanout.chunks += r.chunks;
      report.fanout.merged += r.merged;
    } catch (err) {
      if (err instanceof LostLock) throw err;
      log.error('notification fan-out failed; the batch stays for the next run', { run: ctx.run, err: err as Error });
      // Counted once a run, whichever of its attempts failed (DEVICE_COUNTERS: a run).
      if (!secondFailed) later(() => countDevice(kv, deps.now(), 'fanout_second_failures'));
      secondFailed = true;
    }
    fanoutLeft = Math.max(0, fanoutLeft - (deps.now() - started));
  };
  const names = await officeNames(kv);
  const slots = new SendSlots(CHECKER_SLOTS);
  const stop = { rejected: false };
  // Each batch has its own error boundary: one failing leaves the other to run. Losing the lock ends the pass.
  const guarded = async (kind: 'domestic' | 'abroad', run: () => Promise<BatchReport>): Promise<BatchReport> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof LostLock) throw err;
      log.error(`the ${kind} notification batch failed; the other goes on`, { run: ctx.run, err: err as Error });
      return { ...emptyBatch(), stoppedBy: null };
    }
  };
  await fanout();
  report.domestic = await guarded('domestic', () => batch(deps, { run: ctx.run, kind: 'domestic', checks: deps.checks([ctx.scan]), names, slots, stop }));
  const abroadScan = await ctx.abroadReady;
  await fanout();
  report.abroad = await guarded('abroad', () => batch(deps, { run: ctx.run, kind: 'abroad', checks: deps.checks(abroadScan ? [ctx.scan, abroadScan] : [ctx.scan]), names, slots, stop }));
  return report;
}

/** Office names as alerts give them: the office list, and posts abroad as "Place (Post, Country)". Also the catalogue check. */
async function officeNames(kv: Kv): Promise<{ names: Map<number, string>; abroad: Set<number> }> {
  const raw = await kv.get(K.sites);
  const names = new Map<number, string>(raw ? (JSON.parse(raw) as { id: number; name: string }[]).map((s) => [s.id, s.name]) : []);
  const abroad = new Set<number>();
  for (const p of await catalogPosts(kv)) {
    const d = describePost(p.name, p.country);
    names.set(p.id, `${d.place} (${d.detail})`);
    abroad.add(p.id);
  }
  return { names, abroad };
}

async function batch(
  deps: PassDeps,
  b: { run: string; kind: 'domestic' | 'abroad'; checks: Map<number, DeliveryCheckLike>; names: { names: Map<number, string>; abroad: Set<number> }; slots: SendSlots; stop: { rejected: boolean } },
): Promise<BatchReport> {
  const { kv, log } = deps;
  const r = emptyBatch();
  if (deps.mode === 'off' || !deps.transport) {
    r.stoppedBy = 'mode';
    return r;
  }
  const transport = deps.transport;
  const ids = await workList(kv);
  const cursorKey = K.devCursor(b.kind);
  const cursor = await kv.get(cursorKey);
  const from = cursor === null ? 0 : Math.max(0, ids.findIndex((id) => id > cursor));
  const order = [...ids.slice(from), ...ids.slice(0, from)];
  let firstSend: number | null = null;
  const sends: Promise<void>[] = [];
  // Every send started is awaited before the batch ends, however it ends (a lost lock included).
  try {
    for (const id of order) {
      if (b.stop.rejected) {
        r.stoppedBy = 'rejected';
        break;
      }
      if (await kv.get(K.pushPaused)) {
        r.stoppedBy = 'paused';
        break;
      }
      const release = await b.slots.take();
      // From the slot on, one try: the slot is released on every path that does not hand it to a send.
      let sent = false;
      try {
        // Checked again with the slot in hand: a send that released it may have been rejected meanwhile.
        if (b.stop.rejected) {
          r.stoppedBy = 'rejected';
          break;
        }
        if (firstSend !== null && deps.now() - firstSend >= BATCH_SENDING_MS) {
          r.stoppedBy = 'deadline';
          break;
        }
        r.considered++;
        if (!(await setCursor(kv, { now: deps.now(), run: b.run, kind: b.kind, id }))) throw new LostLock();
        const alert = await kv.hGetAll(K.devAlert(id));
        if (!alert.offices) continue;
        const group = Number(alert.group);
        const open: Record<string, { d: string[]; at: number }> = {};
        const abroad: Record<string, true> = {};
        for (const office of alert.offices.split(',').map(Number)) {
          if (b.names.abroad.has(office)) abroad[String(office)] = true;
          const check = b.checks.get(office);
          const one = check?.dates.get(1);
          const mine = check?.dates.get(group);
          if (!check || !one || !mine) continue;
          const dates = [...mine].filter((d) => one.has(d));
          if (dates.length === 0) continue;
          const at = Math.min(Date.parse(check.times.get(1) ?? check.checkedAt), Date.parse(check.times.get(group) ?? check.checkedAt));
          open[`${office}|${group}`] = { d: dates, at };
        }
        // The reads above may have been slow: the batch's sending time is checked again just before claiming.
        const overdue = () => firstSend !== null && deps.now() - firstSend >= BATCH_SENDING_MS;
        if (overdue()) {
          r.stoppedBy = 'deadline';
          break;
        }
        const stamp = deps.stampNow();
        const cid = newId();
        const c = await claim(kv, { now: deps.now(), run: b.run, id, cid, stamp, day: manilaDay(deps.now()), cap: deps.alertsPerDay, batch: b.kind, open, abroad });
        if (!c.ok) {
          if (c.why === 'lost') throw new LostLock();
          continue;
        }
        r.claimed++;
        // The push service of the generation claimed, read in the claim's own step (a rotation may have completed
        // since the alert was read above): the gate and every settlement use it.
        const svc = c.svc;
        // Every office must be in the catalogue; every date was verified open in this run (so it is published).
        const byOffice = new Map<number, string[]>();
        for (const [office, date] of c.job.d) {
          if (!b.names.names.has(office)) {
            log.warn('a notification date for an office not in the catalogue was dropped', { alert: id, office });
            continue;
          }
          byOffice.set(office, [...(byOffice.get(office) ?? []), date]);
        }
        const openings: Opening[] = [...byOffice].map(([office, dates]) => ({ id: office, name: b.names.names.get(office)!, dates: dates.sort() })).sort((x, y) => x.name.localeCompare(y.name));
        // A fresh reading for the gate: every date's age is checked just before the send, not at the claim.
        // A rejection that arrived while this alert was being claimed fails the gate: the claim goes back unattempted.
        const gate = await sendGate(kv, { now: deps.now(), run: b.run, id, cid, stamp: deps.stampNow(), modeOk: !b.stop.rejected, svc }); // the mode is this run's (off returned above)
        if (!gate.go) {
          if (gate.why === 'lost') throw new LostLock();
          if (b.stop.rejected) {
            r.stoppedBy = 'rejected';
            break;
          }
          continue;
        }
        // A rejection that arrived while the gate ran: this claim goes back unattempted, and nothing more is sent.
        // (From here to transport.send nothing awaits, so no later rejection can slip in before the send starts.)
        if (b.stop.rejected) {
          await settle(kv, { now: deps.now(), run: b.run, id, cid, stamp, result: 'unattempted', backoffUntil: null, svc });
          r.stoppedBy = 'rejected';
          break;
        }
        // Past the batch's sending time while claiming and gating: this claim goes back unattempted, and the batch ends.
        if (overdue()) {
          await settle(kv, { now: deps.now(), run: b.run, id, cid, stamp, result: 'unattempted', backoffUntil: null, svc });
          r.stoppedBy = 'deadline';
          break;
        }
        if (openings.length === 0) {
          await settle(kv, { now: deps.now(), run: b.run, id, cid, stamp, result: 'bug', backoffUntil: null, svc });
          continue;
        }
        firstSend ??= deps.now();
        sent = true;
        sends.push(
          (async () => {
            // One alert's failure (a damaged record, a script error) is logged and costs only that alert.
            let result: SendResult;
            try {
              const opened = openSubscription(deps.keys, gate.sub);
              // Endpoint checks again before every send (spec: "Endpoint checks are kept … when stored and before every send").
              const sub = checkPushSubscription({ endpoint: opened.endpoint, keys: { p256dh: opened.p256dh, auth: opened.auth } });
              if (!sub) {
                log.error('a stored subscription failed the endpoint checks; not sent', { alert: id });
                result = { kind: 'bug', status: null };
              } else {
                const payload = buildPayload({ openings, applicants: group, decisionId: `${b.run}-${id}`.slice(0, 64), checkedAt: c.checked });
                result = await transport.send(sub, payload, { ttl: ALERT_TTL_SECONDS, urgency: 'high' });
              }
            } catch {
              result = { kind: 'bug', status: null };
            }
            if (result.kind === 'accepted') r.accepted++;
            else if (result.kind === 'uncertain') r.uncertain++;
            else if (result.kind === 'gone') r.gone++;
            else r.refused++;
            if (result.kind !== 'accepted') log.warn('notification not accepted', { alert: id, push: loggable(result) });
            if (result.kind === 'rejected') {
              b.stop.rejected = true;
              log.error('a push service rejected our request; notifications stop for this run', { alert: id, push: loggable(result) });
            }
            const backoffUntil = result.kind === 'throttled' ? deps.now() + result.retryAfterMs : null;
            await settle(kv, { now: deps.now(), run: b.run, id, cid, stamp, result: result.kind, backoffUntil, svc }).catch((err: unknown) =>
              log.error('a notification could not be settled; clean-up recovers it', { alert: id, err: err as Error }),
            );
          })().finally(release),
        );
      } catch (err) {
        if (err instanceof LostLock) throw err;
        log.error('a notification alert could not be handled this run', { alert: id, err: err as Error });
      } finally {
        if (!sent) release();
      }
    }
  } finally {
    await Promise.allSettled(sends);
  }
  return r;
}
