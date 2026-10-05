// Reading a subscriber's devices and their sealed records. Ownership changes go
// through push/atomic.ts only; callers hold the subscriber's address lock.
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../crypto.ts';
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Keys } from '../subscribers.ts';
import { type Meta, parseMeta, pushRemove, REVOKED_TTL_SECONDS } from './atomic.ts';

export interface SealedDevice {
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  label: string | null;
  createdAt: string;
  /** Notes from sending: kept here, sealed, like the rest. */
  lastSuccessAt?: string;
  lastFailure?: string;
}

const LABEL = 'push:v1';
/** An awaiting device of an existing subscriber is dropped after this long. */
export const AWAITING_MAX_MS = 48 * 3600_000;

export const sealDevice = (keys: Keys, d: SealedDevice) => seal(JSON.stringify(d), keys.email, LABEL);
export const openDevice = (keys: Keys, sealed: string) => JSON.parse(unseal(sealed, keys.email, LABEL)) as SealedDevice;
export const newDeviceId = () => randomBytes(12).toString('base64url');

export async function listDevices(kv: Kv, subscriberId: string): Promise<{ id: string; meta: Meta }[]> {
  return Object.entries(await kv.hGetAll(K.pushMeta(subscriberId))).map(([id, raw]) => ({ id, meta: parseMeta(raw) }));
}

/** Removes awaiting devices older than 48 hours (a registration in between keeps them). */
export async function pruneAwaiting(kv: Kv, keys: Keys, subscriberId: string, now: number): Promise<number> {
  const sealed = await kv.hGetAll(K.pushDevices(subscriberId));
  let n = 0;
  for (const d of await listDevices(kv, subscriberId)) {
    if (d.meta.state !== 'a' || !sealed[d.id]) continue;
    let createdAt: number;
    try {
      createdAt = Date.parse(openDevice(keys, sealed[d.id]!).createdAt);
    } catch {
      continue; // unreadable (a wrong key or label): kept, never removed for it
    }
    if (now - createdAt <= AWAITING_MAX_MS) continue;
    if ((await pushRemove(kv, { subscriberId, deviceId: d.id, revokeSeconds: 0, onlyIfEndpointHmac: null, onlyIfAwaiting: true })) === 'removed') n++;
  }
  return n;
}

/** Every device of a subscriber, removed the atomic way. */
export async function removeAllDevices(kv: Kv, subscriberId: string, opts: { revoke: boolean }): Promise<number> {
  let n = 0;
  for (const d of await listDevices(kv, subscriberId)) {
    const r = await pushRemove(kv, { subscriberId, deviceId: d.id, revokeSeconds: opts.revoke ? REVOKED_TTL_SECONDS : 0, onlyIfEndpointHmac: null });
    if (r === 'removed') n++;
  }
  return n;
}
