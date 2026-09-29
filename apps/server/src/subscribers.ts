// Subscriptions: a request creates a pending record and a one-time token;
// only following the emailed link (and pressing the button) makes it real.
// Addresses exist only encrypted; the keyed index finds them without
// decrypting.
import { isPace, type Pace, type SubscribeRequest } from '@penge/contracts';
import { decryptEmail, emailIndex, encryptEmail, hashToken, newId, randomToken, verifyUnsubscribe } from './crypto.ts';
import { K } from './keys.ts';
import type { Kv, WriteOp } from './kv.ts';

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
  createdAt: string;
  confirmedAt: string;
}

interface Pending {
  sealedEmail: string;
  index: string;
  siteIds: number[];
  applicants: number;
  pace?: Pace;
  requestedAt: string;
}

/** Store a pending subscription; returns the token for the confirmation link. */
export async function createPending(kv: Kv, keys: Keys, request: SubscribeRequest, now: number): Promise<string> {
  const token = randomToken();
  const pending: Pending = {
    sealedEmail: encryptEmail(request.email, keys.email),
    index: emailIndex(request.email, keys.index),
    siteIds: request.siteIds,
    applicants: request.applicants,
    pace: request.pace,
    requestedAt: new Date(now).toISOString(),
  };
  const hash = hashToken(token);
  await kv.write([
    { op: 'set', key: K.pending(hash), value: JSON.stringify(pending), ttlSeconds: PENDING_TTL_SECONDS },
    { op: 'sAdd', key: K.pendingFor(pending.index), members: [hash] },
    { op: 'expire', key: K.pendingFor(pending.index), ttlSeconds: PENDING_TTL_SECONDS },
  ]);
  return token;
}

export type ConfirmResult =
  | { status: 'confirmed' | 'updated'; subscriberId: string; siteIds: number[]; applicants: number; pace: Pace }
  | { status: 'invalid' };

/**
 * Changes to one address happen one at a time: two confirmations clicked at
 * once must not both see "no subscriber yet" and create two.
 */
async function withAddressLock<T>(kv: Kv, index: string, fn: () => Promise<T>): Promise<T> {
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

/**
 * Use a confirmation token (once). A second subscription for the same address
 * replaces the first. The token is used up only after the change is saved, so
 * a busy address or a failure on the way leaves the link working.
 */
export async function confirm(kv: Kv, token: string, now: number): Promise<ConfirmResult> {
  const key = K.pending(hashToken(token));
  const peek = await kv.get(key);
  if (!peek) return { status: 'invalid' };
  // Every use of one token is for the same address, so its lock also makes the token single-use.
  return withAddressLock(kv, (JSON.parse(peek) as Pending).index, async () => {
    const raw = await kv.get(key);
    if (!raw) return { status: 'invalid' };
    const pending = JSON.parse(raw) as Pending;
    const result = await upsert(kv, pending, now);
    await kv.write([
      { op: 'del', key },
      { op: 'sRem', key: K.pendingFor(pending.index), members: [key.slice(K.pending('').length)] },
    ]);
    return result;
  });
}

async function upsert(kv: Kv, pending: Pending, now: number): Promise<ConfirmResult> {
  const at = new Date(now).toISOString();

  const existingId = await kv.get(K.emailIndex(pending.index));
  const existing = existingId ? await load(kv, existingId) : null;
  const id = existing?.id ?? newId();
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
        createdAt: existing?.createdAt ?? at,
        confirmedAt: at,
      },
    },
    { op: 'set', key: K.emailIndex(pending.index), value: id },
    { op: 'sAdd', key: K.allSubscribers, members: [id] },
    ...pending.siteIds.map((siteId): WriteOp => ({ op: 'sAdd', key: K.siteSubscribers(siteId), members: [id] })),
  );
  await kv.write(ops);
  return {
    status: existing ? 'updated' : 'confirmed',
    subscriberId: id,
    siteIds: pending.siteIds,
    applicants: pending.applicants,
    pace: pending.pace ?? 'hourly',
  };
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
    // Confirmation links not yet used would bring the subscription back: they go too.
    const waiting = await kv.sMembers(K.pendingFor(subscriber.index));
    await kv.write([
      ...subscriber.siteIds.map((siteId): WriteOp => ({ op: 'sRem', key: K.siteSubscribers(siteId), members: [id] })),
      { op: 'del', key: K.subscriber(id) },
      { op: 'del', key: K.emailIndex(subscriber.index) },
      { op: 'sRem', key: K.allSubscribers, members: [id] },
      { op: 'del', key: K.held(id) },
      { op: 'sRem', key: K.heldSubscribers, members: [id] },
      { op: 'del', key: K.lastAlert(id) },
      ...waiting.map((hash): WriteOp => ({ op: 'del', key: K.pending(hash) })),
      { op: 'del', key: K.pendingFor(subscriber.index) },
    ]);
    return true;
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
    createdAt: h.createdAt ?? '',
    confirmedAt: h.confirmedAt ?? '',
  };
}

export function emailOf(subscriber: Subscriber, keys: Keys): string {
  return decryptEmail(subscriber.sealedEmail, keys.email);
}
