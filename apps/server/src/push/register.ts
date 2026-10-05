// What a browser can do with its own credential: ask how its device is,
// register or replace its endpoint, turn it off. Answers say only what the
// credential's holder already knows.
import { createHash } from 'node:crypto';
import type { DeviceState, PushSubscriptionInput } from '@penge/contracts';
import { K } from '../keys.ts';
import type { Kv, ScriptDef } from '../kv.ts';
import { type Keys, load, withAddressLock } from '../subscribers.ts';
import { parseMeta, pushRegister, pushRemove, revokeCredential, REVOKED_TTL_SECONDS } from './atomic.ts';
import { listDevices, openDevice, pruneAwaiting, sealDevice } from './devices.ts';
import { endpointHmac, subscriptionHmac } from './endpoint.ts';

export const credentialHash = (credential: string) => createHash('sha256').update(credential).digest('base64url');

/**
 * Deletes a credential entry only if it still names that owner and the owner's device is gone: one
 * atomic step. An entry that names no subscriber and device at all is deleted too.
 */
const DEL_IF_ORPHAN: ScriptDef = {
  name: 'delIfOrphan',
  lua: `
if redis.call('TYPE', KEYS[1]).ok ~= 'string' or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'kept' end
local s, d = string.match(ARGV[1], '^([^/]+)/(.+)$')
if s then
  local mk = ARGV[2] .. s
  if redis.call('TYPE', mk).ok == 'hash' and redis.call('HEXISTS', mk, d) == 1 then return 'kept' end
end
redis.call('DEL', KEYS[1])
return 'deleted'`,
  memory: (tx, k, a) => {
    if (tx.type(k[0]!) !== 'string' || tx.get(k[0]!) !== a[0]) return 'kept';
    const slash = a[0]!.indexOf('/');
    // As the Lua pattern '^([^/]+)/(.+)$': only a well-formed owner can still have its device.
    if (slash > 0 && slash < a[0]!.length - 1) {
      const mk = `${a[1]}${a[0]!.slice(0, slash)}`;
      if (tx.type(mk) === 'hash' && tx.hGet(mk, a[0]!.slice(slash + 1)) !== null) return 'kept';
    }
    tx.del(k[0]!);
    return 'deleted';
  },
};

/** The device a credential owns, or null. An entry naming a device that no longer exists is removed. */
export async function findDevice(kv: Kv, hash: string): Promise<{ subscriberId: string; deviceId: string } | null> {
  const owner = await kv.get(K.pushCred(hash));
  if (!owner) return null;
  const slash = owner.indexOf('/');
  const subscriberId = owner.slice(0, slash);
  const deviceId = owner.slice(slash + 1);
  // A malformed owner (either part empty) names no device, whatever the store holds.
  const wellFormed = slash > 0 && slash < owner.length - 1;
  if (!wellFormed || (await kv.hGetAll(K.pushMeta(subscriberId)))[deviceId] === undefined) {
    // Rechecked inside the script: a confirmation may have bound it again meanwhile.
    if ((await kv.script(DEL_IF_ORPHAN, [K.pushCred(hash)], [owner, K.pushMeta('')])) === 'kept') return findDevice(kv, hash);
    return null;
  }
  return { subscriberId, deviceId };
}

async function hasPendingRequest(kv: Kv, hash: string): Promise<boolean> {
  for (const tokenHash of await kv.sMembers(K.pushPending(hash))) if (await kv.get(K.pending(tokenHash))) return true;
  return false;
}

export async function deviceCall(
  kv: Kv,
  keys: Keys,
  a: { credential: string; subscription: PushSubscriptionInput | null; revision: number | null; now: number },
): Promise<DeviceState> {
  const hash = credentialHash(a.credential);
  const found = await findDevice(kv, hash);
  if (!found) return (await hasPendingRequest(kv, hash)) ? 'pending' : 'missing';
  const subscriber = await load(kv, found.subscriberId);
  // Bound by a confirmation that has not finished writing the subscriber: still pending.
  if (!subscriber) return 'pending';
  return withAddressLock(kv, subscriber.index, async () => {
    await pruneAwaiting(kv, keys, found.subscriberId, a.now);
    const raw = (await kv.hGetAll(K.pushMeta(found.subscriberId)))[found.deviceId];
    if (raw === undefined) return 'missing';
    if (!a.subscription) return parseMeta(raw).state === 'r' ? 'registered' : 'awaiting';
    const s = a.subscription;
    const sealed = (await kv.hGetAll(K.pushDevices(found.subscriberId)))[found.deviceId];
    const before = sealed ? openDevice(keys, sealed) : null;
    const next = sealDevice(keys, { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, label: before?.label ?? null, createdAt: before?.createdAt ?? new Date(a.now).toISOString() });
    return pushRegister(kv, {
      subscriberId: found.subscriberId, deviceId: found.deviceId, revision: a.revision!,
      endpointHmac: endpointHmac(keys.index, s.endpoint), subscriptionHmac: subscriptionHmac(keys.index, s), sealed: next,
    });
  });
}

/** Revoke first, so a confirmation racing this cannot bind the credential; then remove a bound device, under its address lock. */
export async function turnOffDevice(kv: Kv, credential: string): Promise<{ noChannel: boolean }> {
  const hash = credentialHash(credential);
  await revokeCredential(kv, hash, REVOKED_TTL_SECONDS);
  const found = await findDevice(kv, hash);
  if (!found) return { noChannel: false };
  // The address whose lock any confirmation for this device holds. The provisional address is
  // read first: a confirmation that commits deletes it in the same write that creates the
  // subscriber, so one of these two reads always finds the address while the device exists.
  const index = (await kv.get(K.pushAddress(found.subscriberId))) ?? (await load(kv, found.subscriberId))?.index ?? null;
  // Neither: the device's provisional keys have expired with it, and the credential is revoked.
  if (!index) return { noChannel: false };
  return withAddressLock(kv, index, async () => {
    await pushRemove(kv, { subscriberId: found.subscriberId, deviceId: found.deviceId, revokeSeconds: REVOKED_TTL_SECONDS, onlyIfEndpointHmac: null });
    if ((await listDevices(kv, found.subscriberId)).length === 0) await kv.write([{ op: 'del', key: K.pushAddress(found.subscriberId) }]);
    // Read again under the lock: the address may have been deleted while this waited.
    const now = await load(kv, found.subscriberId);
    if (!now) return { noChannel: false };
    if ((await listDevices(kv, found.subscriberId)).length > 0) return { noChannel: false };
    await kv.write([{ op: 'hSet', key: K.subscriber(found.subscriberId), fields: { pushOn: '0' } }]);
    return { noChannel: !now.emailOn };
  });
}
