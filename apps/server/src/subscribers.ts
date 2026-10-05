// Subscriptions: a request creates a pending record and a one-time token;
// only following the emailed link (and pressing the button) makes it real.
// Addresses exist only encrypted; the keyed index finds them without
// decrypting.
import { type Channels, type ConfirmPreview, isPace, type Pace, type PushOutcome, type SubscribeRequest } from '@penge/contracts';
import { decryptEmail, emailIndex, encryptEmail, hashToken, newId, randomToken, verifyUnsubscribe } from './crypto.ts';
import { K } from './keys.ts';
import type { Kv, WriteOp } from './kv.ts';
import { MAX_DEVICES, PROVISIONAL_TTL_SECONDS, pushBind } from './push/atomic.ts';
import { listDevices, newDeviceId, pruneAwaiting, removeAllDevices, sealDevice } from './push/devices.ts';

export const PENDING_TTL_SECONDS = 48 * 3600;

export interface Keys {
  email: Buffer;
  index: Buffer;
  token: Buffer;
}

export interface Subscriber {
  id: string;
  sealedEmail: string;
  index: string;
  siteIds: number[];
  applicants: number;
  /** How often they may be emailed; subscriptions from before it existed are hourly. */
  pace: Pace;
  /** Subscriptions from before channels get email. */
  emailOn: boolean;
  /** True while any device gets notifications. */
  pushOn: boolean;
  createdAt: string;
  confirmedAt: string;
}

interface Pending {
  sealedEmail: string;
  index: string;
  siteIds: number[];
  applicants: number;
  pace?: Pace;
  /** Absent for a request from a page made before channels. */
  channels?: Channels;
  requestedAt: string;
}

/**
 * Changes to one address happen one at a time: two confirmations clicked at
 * once must not both see "no subscriber yet" and create two.
 */
export async function withAddressLock<T>(kv: Kv, index: string, fn: () => Promise<T>): Promise<T> {
  const key = K.addressLock(index);
  const mine = randomToken();
  for (let attempt = 0; !(await kv.set(key, mine, { nx: true, ttlSeconds: 10 })); attempt++) {
    if (attempt >= 50) throw new Error('this address is busy; try again');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    return await fn();
  } finally {
    if ((await kv.get(key)) === mine) await kv.write([{ op: 'del', key }]);
  }
}

/** Seconds left on a key (-2 missing, -1 none), read through a script so MemoryKv and Valkey agree. */
const ttlOf = async (kv: Kv, key: string) =>
  Number(await kv.script({ name: 'ttl', lua: "return tostring(redis.call('TTL', KEYS[1]))", memory: (tx, k) => String(tx.ttl(k[0]!)) }, [key], []));

/** Store a pending subscription; returns the token for the confirmation link. */
export async function createPending(kv: Kv, keys: Keys, request: SubscribeRequest, now: number): Promise<string> {
  const token = randomToken();
  const pending: Pending = {
    sealedEmail: encryptEmail(request.email, keys.email),
    index: emailIndex(request.email, keys.index),
    siteIds: request.siteIds,
    applicants: request.applicants,
    pace: request.pace,
    ...(request.channels ? { channels: request.channels } : {}),
    requestedAt: new Date(now).toISOString(),
  };
  const hash = hashToken(token);
  await withAddressLock(kv, pending.index, async () => {
    const ops: WriteOp[] = [
      { op: 'set', key: K.pending(hash), value: JSON.stringify(pending), ttlSeconds: PENDING_TTL_SECONDS },
      { op: 'sAdd', key: K.pendingFor(pending.index), members: [hash] },
      { op: 'expire', key: K.pendingFor(pending.index), ttlSeconds: PENDING_TTL_SECONDS },
    ];
    // One reserved id per address while it has none. It lives as long as the latest
    // pending request, and is never shortened (pushBind may have extended it).
    // An hour longer than the token, so the token can never outlive it.
    const reservedTtl = PENDING_TTL_SECONDS + 3600;
    if (!(await kv.get(K.emailIndex(pending.index)))) {
      await kv.set(K.reserved(pending.index), newId(), { nx: true, ttlSeconds: reservedTtl });
      if ((await ttlOf(kv, K.reserved(pending.index))) < reservedTtl) {
        ops.push({ op: 'expire', key: K.reserved(pending.index), ttlSeconds: reservedTtl });
      }
    }
    const ch = request.channels;
    if (ch && (ch.pushOn || !ch.emailOn)) ops.push({ op: 'sAdd', key: K.pendingChannels, members: [`${hash}|${pending.index}`] });
    if (ch?.pushCredentialHash) {
      ops.push(
        { op: 'sAdd', key: K.pushPending(ch.pushCredentialHash), members: [hash] },
        { op: 'expire', key: K.pushPending(ch.pushCredentialHash), ttlSeconds: PENDING_TTL_SECONDS },
      );
    }
    await kv.write(ops);
  });
  return token;
}

export async function previewPending(kv: Kv, token: string): Promise<ConfirmPreview | null> {
  const raw = await kv.get(K.pending(hashToken(token)));
  if (!raw) return null;
  const p = JSON.parse(raw) as Pending;
  const c = p.channels;
  const existing = await kv.get(K.emailIndex(p.index));
  // Only devices that really get notifications (registered); one still awaiting gets nothing yet.
  const devicesKept = existing ? (await listDevices(kv, existing)).filter((d) => d.meta.state === 'r').length : 0;
  return {
    siteIds: p.siteIds,
    applicants: p.applicants,
    pace: p.pace ?? 'hourly',
    channels: c ? { emailOn: c.emailOn, pushOn: c.pushOn, device: c.device, requestedAt: p.requestedAt, pushCredentialHash: c.pushCredentialHash, devicesKept } : null,
  };
}

export type ConfirmResult =
  | { status: 'confirmed' | 'updated'; subscriberId: string; siteIds: number[]; applicants: number; pace: Pace; channels: { emailOn: boolean; pushOn: boolean; push: PushOutcome } }
  | { status: 'invalid' }
  | { status: 'reload' }
  | { status: 'push-unavailable'; reason: 'owned' | 'revoked' | 'off' }
  | { status: 'full' };

/**
 * Use a confirmation token (once). Its steps, in an order that a retry of the
 * same link can always finish: (1) bind the asking device (idempotent for the
 * same owner); then, in one write, (2) write the subscriber, making a provisional
 * device permanent and dropping the address's reservation, and (3) use up the token.
 */
export async function confirm(
  kv: Kv,
  keys: Keys,
  token: string,
  now: number,
  acknowledge?: { emailOn: boolean; pushOn: boolean },
  opts: { pushAllowed?: (email: string) => boolean } = {},
): Promise<ConfirmResult> {
  const hash = hashToken(token);
  const key = K.pending(hash);
  const peek = await kv.get(key);
  if (!peek) return { status: 'invalid' };
  return withAddressLock(kv, (JSON.parse(peek) as Pending).index, async () => {
    const raw = await kv.get(key);
    if (!raw) return { status: 'invalid' };
    const pending = JSON.parse(raw) as Pending;
    const ch = pending.channels;
    // A page from before channels must not confirm a request that changes them.
    if (ch && (!acknowledge || acknowledge.emailOn !== ch.emailOn || acknowledge.pushOn !== ch.pushOn)) return { status: 'reload' };

    const existingId = await kv.get(K.emailIndex(pending.index));
    const existing = existingId ? await load(kv, existingId) : null;
    let id = existing?.id ?? (await kv.get(K.reserved(pending.index)));
    if (!id) {
      // The reservation lapsed (it outlives the token by an hour, so only after a clock jump):
      // make one now, before binding, so a device bound below can always be found by address.
      id = newId();
      await kv.set(K.reserved(pending.index), id, { ttlSeconds: PENDING_TTL_SECONDS + 3600 });
    }
    await pruneAwaiting(kv, keys, id, now);

    // (1) Bind the asking device.
    let push: PushOutcome = 'none';
    if (ch?.pushOn && ch.pushCredentialHash) {
      const allowed = opts.pushAllowed ? opts.pushAllowed(decryptEmail(pending.sealedEmail, keys.email)) : true;
      if (!allowed) {
        if (!ch.emailOn) return { status: 'push-unavailable', reason: 'off' };
        push = 'skipped-off';
      } else {
        const owned = await kv.get(K.pushCred(ch.pushCredentialHash));
        const deviceId = owned?.startsWith(`${id}/`) ? owned.slice(id.length + 1) : newDeviceId();
        const r = await pushBind(kv, {
          subscriberId: id, deviceId, credentialHash: ch.pushCredentialHash,
          sealedAwaiting: sealDevice(keys, { endpoint: null, p256dh: null, auth: null, label: ch.device, createdAt: new Date(now).toISOString() }),
          addressIndex: pending.index, provisionalTtlSeconds: PROVISIONAL_TTL_SECONDS, maxDevices: MAX_DEVICES,
        });
        if (r === 'full') return { status: 'full' };
        push = r === 'bound' ? 'bound' : r === 'kept' ? 'kept' : r === 'owned' ? 'skipped-owned' : 'skipped-revoked';
        if ((push === 'skipped-owned' || push === 'skipped-revoked') && !ch.emailOn) {
          return { status: 'push-unavailable', reason: push === 'skipped-owned' ? 'owned' : 'revoked' };
        }
      }
    }

    // Email as asked (unchanged for a page from before channels); push on while any device exists.
    const devices = await listDevices(kv, id);
    const emailOn = ch ? ch.emailOn : (existing?.emailOn ?? true);
    const pushOn = devices.length > 0;
    if (!emailOn && !pushOn) return { status: 'push-unavailable', reason: 'revoked' };

    // (2) Write the subscriber.
    const at = new Date(now).toISOString();
    const ops: WriteOp[] = [];
    for (const siteId of existing?.siteIds ?? []) {
      if (!pending.siteIds.includes(siteId)) ops.push({ op: 'sRem', key: K.siteSubscribers(siteId), members: [id] });
    }
    ops.push(
      {
        op: 'hSet',
        key: K.subscriber(id),
        fields: {
          email: pending.sealedEmail,
          index: pending.index,
          sites: pending.siteIds.join(','),
          applicants: String(pending.applicants),
          pace: pending.pace ?? 'hourly',
          emailOn: emailOn ? '1' : '0',
          pushOn: pushOn ? '1' : '0',
          createdAt: existing?.createdAt ?? at,
          confirmedAt: at,
        },
      },
      { op: 'set', key: K.emailIndex(pending.index), value: id },
      { op: 'sAdd', key: K.allSubscribers, members: [id] },
      ...pending.siteIds.map((siteId): WriteOp => ({ op: 'sAdd', key: K.siteSubscribers(siteId), members: [id] })),
      { op: 'persist', key: K.pushMeta(id) },
      { op: 'persist', key: K.pushDevices(id) },
      ...devices.filter((d) => d.meta.credentialHash).map((d): WriteOp => ({ op: 'persist', key: K.pushCred(d.meta.credentialHash) })),
      { op: 'del', key: K.reserved(pending.index) },
      { op: 'del', key: K.pushAddress(id) },
    );
    // (3) Use up the token, in the same write: a request is never applied with one
    // effect and left usable to apply again with another (say, once push is switched on).
    ops.push(
      { op: 'del', key },
      { op: 'sRem', key: K.pendingFor(pending.index), members: [hash] },
      { op: 'sRem', key: K.pendingChannels, members: [`${hash}|${pending.index}`] },
      ...(ch?.pushCredentialHash ? [{ op: 'sRem', key: K.pushPending(ch.pushCredentialHash), members: [hash] } as WriteOp] : []),
    );
    await kv.write(ops);
    return {
      status: existing ? 'updated' : 'confirmed',
      subscriberId: id,
      siteIds: pending.siteIds,
      applicants: pending.applicants,
      pace: pending.pace ?? 'hourly',
      channels: { emailOn, pushOn, push },
    };
  });
}

/** Remove a subscriber completely. False when the link is forged or already used. */
export async function unsubscribe(kv: Kv, keys: Keys, token: string): Promise<boolean> {
  const id = verifyUnsubscribe(token, keys.token);
  if (!id) return false;
  const found = await load(kv, id);
  if (!found) return false;
  return withAddressLock(kv, found.index, async () => {
    const subscriber = await load(kv, id);
    if (!subscriber) return false;
    await removeAddress(kv, subscriber.index, subscriber);
    return true;
  });
}

/** Delete subscription data, devices and every unused confirmation/deletion link for an address. Caller holds its lock. */
async function removeAddress(kv: Kv, index: string, subscriber: Subscriber | null): Promise<void> {
  // Devices first, under the subscriber id and under the address's reservation
  // (a confirmation that died after binding), while those ids can still be found.
  const reserved = await kv.get(K.reserved(index));
  for (const id of new Set([subscriber?.id, reserved].filter((x): x is string => !!x))) {
    await removeAllDevices(kv, id, { revoke: true });
    await kv.write([{ op: 'del', key: K.pushAddress(id) }]);
  }
  const waiting = await kv.sMembers(K.pendingFor(index));
  const deletions = await kv.sMembers(K.deletionsFor(index));
  // Channel requests of this address, including those whose pending record (and so
  // its place in pendingFor) has expired: the member still names the address.
  const channelRequests = (await kv.sMembers(K.pendingChannels)).filter((m) => m.endsWith(`|${index}`));
  const credentialSets: WriteOp[] = [];
  for (const hash of waiting) {
    const raw = await kv.get(K.pending(hash));
    const c = raw ? (JSON.parse(raw) as Pending).channels : undefined;
    if (!c?.pushCredentialHash) continue;
    // Its own request, and any whose link expired: the set lives 48 h from its newest
    // request, so an expired member can only linger beside a request still waiting.
    const members = await kv.sMembers(K.pushPending(c.pushCredentialHash));
    const gone: string[] = [];
    for (const m of members) if (m === hash || !(await kv.get(K.pending(m)))) gone.push(m);
    credentialSets.push({ op: 'sRem', key: K.pushPending(c.pushCredentialHash), members: gone });
  }
  await kv.write([
    ...(subscriber
      ? [
          ...subscriber.siteIds.map((siteId): WriteOp => ({ op: 'sRem', key: K.siteSubscribers(siteId), members: [subscriber.id] })),
          { op: 'del', key: K.subscriber(subscriber.id) } as WriteOp,
          { op: 'sRem', key: K.allSubscribers, members: [subscriber.id] } as WriteOp,
          { op: 'del', key: K.held(subscriber.id) } as WriteOp,
          { op: 'sRem', key: K.heldSubscribers, members: [subscriber.id] } as WriteOp,
          { op: 'del', key: K.lastAlert(subscriber.id) } as WriteOp,
        ]
      : []),
    { op: 'del', key: K.emailIndex(index) },
    { op: 'del', key: K.reserved(index) },
    ...credentialSets,
    ...waiting.map((hash): WriteOp => ({ op: 'del', key: K.pending(hash) })),
    ...(channelRequests.length ? [{ op: 'sRem', key: K.pendingChannels, members: channelRequests } as WriteOp] : []),
    { op: 'del', key: K.pendingFor(index) },
    ...deletions.map((hash): WriteOp => ({ op: 'del', key: K.deletion(hash) })),
    { op: 'del', key: K.deletionsFor(index) },
  ]);
}

/** For push-downgrade and restore: remove an address the way unsubscribing does. Caller holds its lock. */
export async function removeSubscriberByIndex(kv: Kv, index: string): Promise<void> {
  const id = await kv.get(K.emailIndex(index));
  await removeAddress(kv, index, id ? await load(kv, id) : null);
}

/** Every valid address gets the same email; only its owner can use the random, one-time link. */
export async function createDeletion(kv: Kv, keys: Keys, email: string): Promise<string> {
  const index = emailIndex(email, keys.index);
  return withAddressLock(kv, index, async () => {
    const token = randomToken();
    const hash = hashToken(token);
    await kv.write([
      { op: 'set', key: K.deletion(hash), value: index, ttlSeconds: PENDING_TTL_SECONDS },
      { op: 'sAdd', key: K.deletionsFor(index), members: [hash] },
      { op: 'expire', key: K.deletionsFor(index), ttlSeconds: PENDING_TTL_SECONDS },
    ]);
    return token;
  });
}

/** A GET never deletes. Recheck the token under the same lock used by confirmation/unsubscribe. */
export async function deleteWithToken(kv: Kv, token: string): Promise<{ valid: boolean; removed: boolean }> {
  const key = K.deletion(hashToken(token));
  const index = await kv.get(key);
  if (!index) return { valid: false, removed: false };
  return withAddressLock(kv, index, async () => {
    if ((await kv.get(key)) !== index) return { valid: false, removed: false };
    const id = await kv.get(K.emailIndex(index));
    const subscriber = id ? await load(kv, id) : null;
    await removeAddress(kv, index, subscriber);
    return { valid: true, removed: subscriber !== null };
  });
}

export async function load(kv: Kv, id: string): Promise<Subscriber | null> {
  const h = await kv.hGetAll(K.subscriber(id));
  if (!h.email || !h.index || !h.sites || !h.applicants) return null;
  return {
    id,
    sealedEmail: h.email,
    index: h.index,
    siteIds: h.sites.split(',').map(Number).filter(Number.isSafeInteger),
    applicants: Number(h.applicants),
    pace: isPace(h.pace) ? h.pace : 'hourly',
    emailOn: h.emailOn !== '0',
    pushOn: h.pushOn === '1',
    createdAt: h.createdAt ?? '',
    confirmedAt: h.confirmedAt ?? '',
  };
}

export function emailOf(subscriber: Subscriber, keys: Keys): string {
  return decryptEmail(subscriber.sealedEmail, keys.email);
}
