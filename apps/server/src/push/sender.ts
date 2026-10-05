// Sends pushes: at most PUSH_IN_FLIGHT at once, PUSH_TIMEOUT_MS each, and no
// new decision after PUSH_BUDGET_MS of a delivery pass, so slow push services
// cannot hold up email or outlast the checker's lock.
import webpush from 'web-push';
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Logger } from '../log.ts';
import { type Keys, withAddressLock } from '../subscribers.ts';
import { parseMeta, pushRemove } from './atomic.ts';
import { listDevices, openDevice, type SealedDevice, sealDevice } from './devices.ts';
import { checkPushSubscription, endpointHmac } from './endpoint.ts';
import { classifyPushError } from './errors.ts';

export const PUSH_TTL_SECONDS = 1800;
export const PUSH_IN_FLIGHT = 8;
export const PUSH_TIMEOUT_MS = 5000;
export const PUSH_BUDGET_MS = 60_000;

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };

export interface PushTransport {
  send(sub: Sub, payload: string, opts: { TTL: number; urgency: 'high'; timeout: number }): Promise<void>;
}

export function webPushTransport(vapid: { publicKey: string; privateKey: string; subject: string }): PushTransport {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(sub, payload, opts) {
      await webpush.sendNotification(sub, payload, { TTL: opts.TTL, urgency: opts.urgency, timeout: opts.timeout });
    },
  };
}

export type DeviceOutcome = {
  deviceId: string;
  endpointHmac: string;
  result: 'accepted' | 'gone' | 'refused' | 'too-big' | 'uncertain' | 'invalid';
  status: number | null;
};

export class PushPool {
  private readonly started: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly o: { transport: PushTransport; inFlight: number; budgetMs: number; timeoutMs: number; now: () => number }) {
    this.started = o.now();
  }
  hasBudget() {
    return this.o.now() - this.started < this.o.budgetMs;
  }
  /** Room for one more decision's pushes; asked before the claim. */
  reserve() {
    return this.hasBudget();
  }
  async send(deviceId: string, endpointHmac: string, sub: Sub, payload: string): Promise<DeviceOutcome> {
    // A freed slot passes straight to the next waiter (see the release below), so a send
    // arriving meanwhile can never take it too.
    if (this.running >= this.o.inFlight) await new Promise<void>((r) => this.waiting.push(r));
    else this.running++;
    // web-push closes its socket after `timeout`; this deadline also covers a transport
    // that never settles, so a slot is never held for good. Past it, the push may have
    // gone out: uncertain, so it is never sent twice.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Socket timeout')), this.o.timeoutMs + 1000);
    });
    // Called inside the chain, so a transport that throws at once is classified and frees its slot too.
    const sending = Promise.resolve().then(() => this.o.transport.send(sub, payload, { TTL: PUSH_TTL_SECONDS, urgency: 'high', timeout: this.o.timeoutMs }));
    const job = Promise.race([sending, deadline])
      .finally(() => clearTimeout(timer))
      .then((): DeviceOutcome => ({ deviceId, endpointHmac, result: 'accepted', status: 201 }))
      .catch((err: unknown): DeviceOutcome => {
        const f = classifyPushError(err);
        return { deviceId, endpointHmac, result: f.category, status: f.status };
      })
      .finally(() => {
        const next = this.waiting.shift();
        if (next) next();
        else this.running--;
      });
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
    return job;
  }
  /** Waits for every send that started. */
  async settle() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

/** One decision's pushes, to every registered device of a subscriber (or to one). */
export async function pushDecision(
  deps: { kv: Kv; keys: Keys; pool: PushPool; log: Logger; now: () => number },
  a: { subscriberId: string; index: string; payload: string; onlyDeviceId?: string },
): Promise<{ any: 'accepted' | 'uncertain' | 'none'; outcomes: DeviceOutcome[]; removed: number }> {
  // The sealed records and their metadata are read together, under the lock, so a
  // registration cannot slip between the two reads. The sends happen outside it.
  let snapshot: { sealed: Record<string, string>; devices: Awaited<ReturnType<typeof listDevices>> };
  try {
    snapshot = await withAddressLock(deps.kv, a.index, async () => ({
      sealed: await deps.kv.hGetAll(K.pushDevices(a.subscriberId)),
      devices: await listDevices(deps.kv, a.subscriberId),
    }));
  } catch (err) {
    // Nothing was sent: the alert is settled as push not delivered (and tried again if nothing else carried it).
    deps.log.warn('push not started: its devices could not be read', { err: err as Error });
    return { any: 'none', outcomes: [], removed: 0 };
  }
  const sends: Promise<DeviceOutcome>[] = [];
  const invalid: DeviceOutcome[] = [];
  for (const d of snapshot.devices) {
    if (d.meta.state !== 'r' || (a.onlyDeviceId && d.id !== a.onlyDeviceId) || !snapshot.sealed[d.id]) continue;
    let dev: SealedDevice;
    try {
      dev = openDevice(deps.keys, snapshot.sealed[d.id]!);
    } catch {
      // Unreadable (a wrong key or label): skipped and kept, never removed for it.
      invalid.push({ deviceId: d.id, endpointHmac: d.meta.endpointHmac, result: 'refused', status: null });
      continue;
    }
    const checked = checkPushSubscription({ endpoint: dev.endpoint, keys: { p256dh: dev.p256dh, auth: dev.auth } });
    if (!checked || endpointHmac(deps.keys.index, checked.endpoint) !== d.meta.endpointHmac) {
      invalid.push({ deviceId: d.id, endpointHmac: d.meta.endpointHmac, result: 'invalid', status: null });
      continue;
    }
    sends.push(deps.pool.send(d.id, d.meta.endpointHmac, { endpoint: checked.endpoint, keys: { p256dh: checked.p256dh, auth: checked.auth } }, a.payload));
  }
  const outcomes = [...invalid, ...(await Promise.all(sends))];
  const at = new Date(deps.now()).toISOString();
  let removed = 0;
  // Clean-up and notes under the address lock, and only for devices that still have the endpoint sent to.
  // If the address stays busy they are skipped: what was sent stands either way.
  await withAddressLock(deps.kv, a.index, async () => {
    const meta = await deps.kv.hGetAll(K.pushMeta(a.subscriberId));
    const sealed = await deps.kv.hGetAll(K.pushDevices(a.subscriberId));
    const notes: Record<string, string> = {};
    for (const o of outcomes) {
      if (o.result === 'gone' || o.result === 'invalid') {
        if ((await pushRemove(deps.kv, { subscriberId: a.subscriberId, deviceId: o.deviceId, revokeSeconds: 0, onlyIfEndpointHmac: o.endpointHmac || null })) === 'removed') removed++;
        continue;
      }
      const raw = meta[o.deviceId];
      if (!raw || parseMeta(raw).endpointHmac !== o.endpointHmac || !sealed[o.deviceId]) continue;
      let dev: SealedDevice;
      try {
        dev = openDevice(deps.keys, sealed[o.deviceId]!);
      } catch {
        continue;
      }
      const next = o.result === 'accepted' ? { ...dev, lastSuccessAt: at } : { ...dev, lastFailure: `${at} ${o.status ?? ''} ${o.result}`.replace(/\s+/g, ' ').trim() };
      notes[o.deviceId] = sealDevice(deps.keys, next);
    }
    if (Object.keys(notes).length > 0) await deps.kv.write([{ op: 'hSet', key: K.pushDevices(a.subscriberId), fields: notes }]);
  }).catch((err: unknown) => deps.log.warn('push clean-up skipped: the address was busy', { err: err as Error }));
  for (const o of outcomes) if (o.result !== 'accepted') deps.log.warn('push not accepted', { device: o.deviceId, status: o.status, category: o.result });
  const any = outcomes.some((o) => o.result === 'accepted') ? 'accepted' : outcomes.some((o) => o.result === 'uncertain') ? 'uncertain' : 'none';
  return { any, outcomes, removed };
}
