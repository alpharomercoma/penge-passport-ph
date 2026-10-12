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
  /** The channel release (05cee09) stored email off, or a flag that is not "1": never emailed (the owner decides). */
  emailOff: boolean;
}

/** Fields only the channel release wrote on a subscriber; a new email confirmation removes them. */
const CHANNEL_FIELDS = ['emailOn', 'pushOn', 'pushCredentialHash', 'device'];

/** The channel release's per-subscriber device records (no longer in keys.ts): deleted with the subscriber. */
const LEGACY_PUSH = {
  devices: (id: string) => `pp:push:${id}`,
  meta: (id: string) => `pp:push:meta:${id}`,
  cred: (hash: string) => `pp:push:cred:${hash}`,
  endpoint: (hmac: string) => `pp:push:endpoint:${hmac}`,
  /** Set of pending-token hashes asking for notifications on a credential. */
  pending: (credentialHash: string) => `pp:push:pending:${credentialHash}`,
  /** Set of "<token hash>|<address index>" for pending requests that carried channels. */
  pendingChannels: 'pp:pending:channels',
};

interface Pending {
  sealedEmail: string;
  index: string;
  siteIds: number[];
  applicants: number;
  pace?: Pace;
  requestedAt: string;
  /** Written only by the channel release (05cee09); never written now. Email off there is never email consent here. */
  channels?: unknown;
}

/**
 * Whether a pending request is email consent: one stored before channels (no field), or one the channel release stored
 * with email on and a well-formed notifications flag. Anything else (email off, null, malformed) is never confirmed.
 */
function emailConsent(p: Pending): boolean {
  if (p.channels === undefined) return true;
  const c = p.channels as { emailOn?: unknown; pushOn?: unknown } | null;
  return typeof c === 'object' && c !== null && c.emailOn === true && (c.pushOn === undefined || typeof c.pushOn === 'boolean');
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
  await withAddressLock(kv, pending.index, () => kv.write([
    { op: 'set', key: K.pending(hash), value: JSON.stringify(pending), ttlSeconds: PENDING_TTL_SECONDS },
    { op: 'sAdd', key: K.pendingFor(pending.index), members: [hash] },
    { op: 'expire', key: K.pendingFor(pending.index), ttlSeconds: PENDING_TTL_SECONDS },
  ]));
  return token;
}

/** What a pending link will do, for pages of the channel release, which ask before confirming: email, as always. */
export async function previewPending(kv: Kv, token: string): Promise<{ siteIds: number[]; applicants: number; pace: Pace; channels: null } | null> {
  const raw = await kv.get(K.pending(hashToken(token)));
  if (!raw) return null;
  const p = JSON.parse(raw) as Pending;
  if (!emailConsent(p)) return null;
  return { siteIds: p.siteIds, applicants: p.applicants, pace: p.pace ?? 'hourly', channels: null };
}

export type ConfirmResult =
  | { status: 'confirmed' | 'updated'; subscriberId: string; siteIds: number[]; applicants: number; pace: Pace }
  | { status: 'invalid' };

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
  const peeked = JSON.parse(peek) as Pending;
  if (!emailConsent(peeked)) return { status: 'invalid' };
  return withAddressLock(kv, peeked.index, async () => {
    const raw = await kv.get(key);
    if (!raw) return { status: 'invalid' };
    const pending = JSON.parse(raw) as Pending;
    if (!emailConsent(pending)) return { status: 'invalid' };
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
    // Confirming email is consent to email now, whatever the channel release stored before.
    { op: 'hDel', key: K.subscriber(id), fields: CHANNEL_FIELDS },
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
    await removeAddress(kv, subscriber.index, subscriber);
    return true;
  });
}

/** Delete subscription data and every unused confirmation/deletion link for an address. Caller holds its lock. */
async function removeAddress(kv: Kv, index: string, subscriber: Subscriber | null): Promise<void> {
  const waiting = await kv.sMembers(K.pendingFor(index));
  const deletions = await kv.sMembers(K.deletionsFor(index));
  // The channel release's device records for this subscriber, and the pointers to them that still name it; and its index
  // entries for this address's waiting requests.
  const legacy: WriteOp[] = [];
  // Every channel index entry for this address, its request still waiting or long expired.
  const channelEntries = (await kv.sMembers(LEGACY_PUSH.pendingChannels).catch(() => [] as string[])).filter((m) => m.endsWith(`|${index}`));
  if (channelEntries.length > 0) legacy.push({ op: 'sRem', key: LEGACY_PUSH.pendingChannels, members: channelEntries });
  for (const hash of waiting) {
    const raw = await kv.get(K.pending(hash)).catch(() => null);
    let cred: unknown = null;
    try {
      cred = raw ? (JSON.parse(raw) as { channels?: { pushCredentialHash?: unknown } }).channels?.pushCredentialHash : null;
    } catch {
      cred = null;
    }
    if (typeof cred === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(cred)) legacy.push({ op: 'sRem', key: LEGACY_PUSH.pending(cred), members: [hash] });
  }
  if (subscriber) {
    legacy.push({ op: 'del', key: LEGACY_PUSH.devices(subscriber.id) }, { op: 'del', key: LEGACY_PUSH.meta(subscriber.id) });
    const meta = await kv.hGetAll(LEGACY_PUSH.meta(subscriber.id)).catch(() => ({}) as Record<string, string>);
    for (const [device, value] of Object.entries(meta)) {
      const [, , credHash, endpointHmac] = value.split('|');
      for (const key of [credHash ? LEGACY_PUSH.cred(credHash) : null, endpointHmac ? LEGACY_PUSH.endpoint(endpointHmac) : null]) {
        if (key && (await kv.get(key).catch(() => null)) === `${subscriber.id}/${device}`) legacy.push({ op: 'del', key });
      }
    }
  }
  await kv.write([
    ...legacy,
    ...(subscriber ? [
      ...subscriber.siteIds.map((siteId): WriteOp => ({ op: 'sRem', key: K.siteSubscribers(siteId), members: [subscriber.id] })),
      { op: 'del', key: K.subscriber(subscriber.id) } as WriteOp,
      { op: 'sRem', key: K.allSubscribers, members: [subscriber.id] } as WriteOp,
      { op: 'del', key: K.held(subscriber.id) } as WriteOp,
      { op: 'sRem', key: K.heldSubscribers, members: [subscriber.id] } as WriteOp,
      { op: 'del', key: K.lastAlert(subscriber.id) } as WriteOp,
    ] : []),
    { op: 'del', key: K.emailIndex(index) },
    ...waiting.map((hash): WriteOp => ({ op: 'del', key: K.pending(hash) })),
    { op: 'del', key: K.pendingFor(index) },
    ...deletions.map((hash): WriteOp => ({ op: 'del', key: K.deletion(hash) })),
    { op: 'del', key: K.deletionsFor(index) },
  ]);
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
    const found = id ? await load(kv, id) : null;
    // Only the subscriber this address really belongs to: a pointer naming a record of another address (a damaged
    // store) deletes nobody.
    const subscriber = found && found.index === index ? found : null;
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
    createdAt: h.createdAt ?? '',
    confirmedAt: h.confirmedAt ?? '',
    emailOff: h.emailOn !== undefined && h.emailOn !== '1',
  };
}

export function emailOf(subscriber: Subscriber, keys: Keys): string {
  return decryptEmail(subscriber.sealedEmail, keys.email);
}
