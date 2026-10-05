import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Channels, SubscribeRequest } from '@penge/contracts';
import { K } from '../src/keys.ts';
import { type Kv, MemoryKv, type WriteOp } from '../src/kv.ts';
import { pushRemove, REVOKED_TTL_SECONDS } from '../src/push/atomic.ts';
import { listDevices } from '../src/push/devices.ts';
import { confirm, createDeletion, createPending, deleteWithToken, load, previewPending } from '../src/subscribers.ts';
import { clock, keys } from './helpers.ts';

const hashOf = (s: string) => createHash('sha256').update(s).digest('base64url');
const newCredHash = () => hashOf(randomBytes(32).toString('base64url'));
const req = (channels: Channels | null, over: Partial<SubscribeRequest> = {}): SubscribeRequest => ({
  email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels, ...over,
});
const emailOnly: Channels = { emailOn: true, pushOn: false, pushCredentialHash: null, device: null };
const pushOnly = (h: string): Channels => ({ emailOn: false, pushOn: true, pushCredentialHash: h, device: 'Chrome on Android' });
const both = (h: string): Channels => ({ emailOn: true, pushOn: true, pushCredentialHash: h, device: 'Chrome on Android' });
const ack = (c: Channels) => ({ emailOn: c.emailOn, pushOn: c.pushOn });
const idOf = (r: Awaited<ReturnType<typeof confirm>>) => (r.status === 'confirmed' || r.status === 'updated' ? r.subscriberId : '');

/** A kv on which the write that creates or updates a subscriber hash fails, as if the process died there. */
function dyingAtSubscriberWrite(kv: MemoryKv): Kv {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === 'write') {
        return async (ops: WriteOp[]) => {
          if (ops.some((o) => o.op === 'hSet' && o.key.startsWith(K.subscriber('')))) throw new Error('process died');
          return target.write(ops);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Kv;
}
/** A kv on which using up a token fails, after the subscriber was written. */
function dyingAtTokenUse(kv: MemoryKv): Kv {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === 'write') {
        return async (ops: WriteOp[]) => {
          if (ops.some((o) => o.op === 'del' && o.key.startsWith(K.pending('')))) throw new Error('process died');
          return target.write(ops);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Kv;
}
const pushKeys = (kv: MemoryKv) => kv.keys().filter((k) => k.startsWith('pp:push') && !k.startsWith(K.pushRevoked('')));

describe('subscribing with channels', () => {
  it('previews without changing anything, with the credential hash', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    const token = await createPending(kv, keys, req(pushOnly(h)), t.now());
    const before = kv.dump();
    expect(await previewPending(kv, token)).toMatchObject({ siteIds: [486], channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', pushCredentialHash: h, devicesKept: 0 } });
    expect(kv.dump()).toBe(before);
  });

  it('counts as kept only devices that really get notifications', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = both(newCredHash());
    await confirm(kv, keys, await createPending(kv, keys, req(c), t.now()), t.now(), ack(c)); // its device never registered
    const laptop = await createPending(kv, keys, req(emailOnly), t.now());
    expect(await previewPending(kv, laptop)).toMatchObject({ channels: { devicesKept: 0 } });
  });

  it('refuses a channel request confirmed without acknowledgement, and keeps the token usable', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    expect((await confirm(kv, keys, token, t.now())).status).toBe('reload');
    expect((await confirm(kv, keys, token, t.now(), { emailOn: true, pushOn: true })).status).toBe('reload');
    expect(await confirm(kv, keys, token, t.now(), ack(c))).toMatchObject({ status: 'confirmed', channels: { emailOn: false, pushOn: true, push: 'bound' } });
  });

  it('still confirms a pending request from before channels with the token alone', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const token = await createPending(kv, keys, req(null), t.now());
    expect(await confirm(kv, keys, token, t.now())).toMatchObject({ status: 'confirmed', channels: { emailOn: true, pushOn: false, push: 'none' } });
  });

  it('never turns email on when push cannot be bound and email is off, and keeps the token', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    await confirm(kv, keys, await createPending(kv, keys, req(pushOnly(h), { email: 'ana@example.com' }), t.now()), t.now(), ack(pushOnly(h)));
    const b = await createPending(kv, keys, req(pushOnly(h), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), ack(pushOnly(h)))).toEqual({ status: 'push-unavailable', reason: 'owned' });
    expect(await kv.get(K.pending(hashOf(b)))).not.toBeNull();
    expect(await kv.sMembers(K.allSubscribers)).toHaveLength(1);
  });

  it('applies the rest when push cannot be bound but email is on', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    await confirm(kv, keys, await createPending(kv, keys, req(pushOnly(h), { email: 'ana@example.com' }), t.now()), t.now(), ack(pushOnly(h)));
    const b = await createPending(kv, keys, req(both(h), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), ack(both(h)))).toMatchObject({ status: 'confirmed', channels: { emailOn: true, pushOn: false, push: 'skipped-owned' } });
  });

  it('recovers from an owned credential: turn it off there, submit again with a fresh credential', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    const a = await confirm(kv, keys, await createPending(kv, keys, req(pushOnly(h), { email: 'ana@example.com' }), t.now()), t.now(), ack(pushOnly(h)));
    const [dev] = await listDevices(kv, idOf(a));
    await pushRemove(kv, { subscriberId: idOf(a), deviceId: dev!.id, revokeSeconds: REVOKED_TTL_SECONDS, onlyIfEndpointHmac: null });
    const fresh = newCredHash();
    const b = await createPending(kv, keys, req(pushOnly(fresh), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), ack(pushOnly(fresh)))).toMatchObject({ status: 'confirmed', channels: { push: 'bound' } });
  });

  it('respects push being off, or owner-only, at confirmation time', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const off = () => false;
    const a = await createPending(kv, keys, req(pushOnly(newCredHash()), { email: 'ana@example.com' }), t.now());
    expect(await confirm(kv, keys, a, t.now(), { emailOn: false, pushOn: true }, { pushAllowed: off })).toEqual({ status: 'push-unavailable', reason: 'off' });
    const b = await createPending(kv, keys, req(both(newCredHash()), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), { emailOn: true, pushOn: true }, { pushAllowed: off })).toMatchObject({ channels: { emailOn: true, pushOn: false, push: 'skipped-off' } });
    const ownerOnly = (email: string) => email === 'juan@example.com';
    const c = await createPending(kv, keys, req(both(newCredHash())), t.now());
    expect(await confirm(kv, keys, c, t.now(), { emailOn: true, pushOn: true }, { pushAllowed: ownerOnly })).toMatchObject({ channels: { push: 'bound' } });
  });

  it('keeps a phone\'s notifications when offices are changed from a laptop (Review Focus 1)', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    const first = await confirm(kv, keys, await createPending(kv, keys, req(both(h)), t.now()), t.now(), ack(both(h)));
    const laptop = await createPending(kv, keys, req(emailOnly, { siteIds: [486, 693] }), t.now());
    await confirm(kv, keys, laptop, t.now(), ack(emailOnly));
    expect(await load(kv, idOf(first))).toMatchObject({ pushOn: true, siteIds: [486, 693] });
    expect(await listDevices(kv, idOf(first))).toHaveLength(1);
  });

  it('finishes a confirmation that died after binding when the link is retried', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    await expect(confirm(dyingAtSubscriberWrite(kv), keys, token, t.now(), ack(c))).rejects.toThrow('process died');
    expect(await confirm(kv, keys, token, t.now(), ack(c))).toMatchObject({ status: 'confirmed', channels: { push: 'kept' } });
  });

  it('writes the subscriber and uses up the token in one step: a crash there applies nothing, and the retry finishes', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    await expect(confirm(dyingAtTokenUse(kv), keys, token, t.now(), ack(c))).rejects.toThrow('process died');
    expect(await kv.sMembers(K.allSubscribers)).toEqual([]);
    const r = await confirm(kv, keys, token, t.now(), ack(c));
    expect(r).toMatchObject({ status: 'confirmed', channels: { push: 'kept' } });
    expect(await listDevices(kv, idOf(r))).toHaveLength(1);
    expect(await kv.get(K.reserved(await indexOf(kv, idOf(r))))).toBeNull();
  });

  it('never applies a request with one effect and then lets its link apply it again with another', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = both(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    // Push is off when it is first confirmed, and the process dies at the end.
    await expect(confirm(dyingAtTokenUse(kv), keys, token, t.now(), ack(c), { pushAllowed: () => false })).rejects.toThrow('process died');
    expect(await kv.sMembers(K.allSubscribers)).toEqual([]); // nothing was applied
    expect(await confirm(kv, keys, token, t.now(), ack(c))).toMatchObject({ status: 'confirmed', channels: { pushOn: true, push: 'bound' } });
    expect((await confirm(kv, keys, token, t.now(), ack(c))).status).toBe('invalid');
  });

  it('turns push off for a subscriber whose last device is dropped, even when the confirmation then fails', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const first = both(newCredHash());
    const r = await confirm(kv, keys, await createPending(kv, keys, req(first), t.now()), t.now(), ack(first));
    expect(await load(kv, idOf(r))).toMatchObject({ pushOn: true });
    t.advance(49 * 3600_000); // its device never registered: it is dropped at the next confirmation
    const revoked = pushOnly(newCredHash());
    await kv.set(K.pushRevoked(revoked.pushCredentialHash!), '1', { ttlSeconds: REVOKED_TTL_SECONDS });
    expect(await confirm(kv, keys, await createPending(kv, keys, req(revoked), t.now()), t.now(), ack(revoked))).toEqual({ status: 'push-unavailable', reason: 'revoked' });
    expect(await listDevices(kv, idOf(r))).toEqual([]);
    expect(await load(kv, idOf(r))).toMatchObject({ pushOn: false });
  });

  it('removes the address from pending channel requests when it is deleted, even after the requests expired', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    await createPending(kv, keys, req(pushOnly(newCredHash())), t.now());
    await createPending(kv, keys, req(pushOnly(newCredHash()), { email: 'ana@example.com' }), t.now());
    t.advance(49 * 3600_000);
    await deleteWithToken(kv, await createDeletion(kv, keys, 'juan@example.com'));
    const left = await kv.sMembers(K.pendingChannels);
    expect(left).toHaveLength(1); // ana's, not juan's
    expect(left[0]!.endsWith(`|${(await import('../src/crypto.ts')).emailIndex('ana@example.com', keys.index)}`)).toBe(true);
  });

  it('leaves no request of a deleted address waiting on its credential, even one whose link expired', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    await createPending(kv, keys, req(c), t.now());
    t.advance(3600_000);
    await createPending(kv, keys, req(c), t.now()); // the same browser asks again an hour later
    t.advance(47.5 * 3600_000); // the first link has expired; the second has not
    await deleteWithToken(kv, await createDeletion(kv, keys, 'juan@example.com'));
    expect(await kv.sMembers(K.pushPending(c.pushCredentialHash!))).toEqual([]);
  });

  it('uses one id for every confirmation of one address, even after a crash', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const a = await createPending(kv, keys, req(c), t.now());
    const b = await createPending(kv, keys, req(emailOnly), t.now());
    await expect(confirm(dyingAtSubscriberWrite(kv), keys, a, t.now(), ack(c))).rejects.toThrow('process died');
    const rb = await confirm(kv, keys, b, t.now(), ack(emailOnly));
    const ra = await confirm(kv, keys, a, t.now(), ack(c));
    expect(rb.status).toBe('confirmed');
    expect(ra).toMatchObject({ status: 'updated', channels: { emailOn: false, pushOn: true } });
    expect(idOf(ra)).toBe(idOf(rb));
  });

  it('leaves no device after deleting an address whose confirmation died after binding past the link expiry', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    t.advance(47 * 3600_000);
    await expect(confirm(dyingAtSubscriberWrite(kv), keys, token, t.now(), ack(c))).rejects.toThrow('process died');
    t.advance(2 * 3600_000); // the link has expired; the reservation was extended by the bind
    await deleteWithToken(kv, await createDeletion(kv, keys, 'juan@example.com'));
    expect(pushKeys(kv)).toEqual([]);
    expect(kv.keys().filter((k) => k.startsWith('pp:reserved'))).toEqual([]);
    expect(await kv.get(K.pushRevoked(c.pushCredentialHash!))).toBe('1'); // revoked markers stay for their 72 h
  });

  it('never shortens a reservation a bind extended, so deleting the address later still finds the device', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    await expect(confirm(dyingAtSubscriberWrite(kv), keys, token, t.now(), ack(c))).rejects.toThrow('process died');
    await createPending(kv, keys, req(emailOnly), t.now()); // asks again: must not cut the reservation back to 49 h
    t.advance(50 * 3600_000);
    await deleteWithToken(kv, await createDeletion(kv, keys, 'juan@example.com'));
    expect(pushKeys(kv)).toEqual([]);
  });

  it('cancels a turned-off credential: a second confirmation cannot bring it back', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = both(newCredHash());
    const a = await createPending(kv, keys, req(c), t.now());
    const b = await createPending(kv, keys, req(c), t.now());
    const ra = await confirm(kv, keys, a, t.now(), ack(c));
    const [dev] = await listDevices(kv, idOf(ra));
    await pushRemove(kv, { subscriberId: idOf(ra), deviceId: dev!.id, revokeSeconds: REVOKED_TTL_SECONDS, onlyIfEndpointHmac: null });
    expect(await confirm(kv, keys, b, t.now(), ack(c))).toMatchObject({ channels: { push: 'skipped-revoked' } });
  });

  it('drops an awaiting device of an existing subscriber after 48 hours, freeing its slot', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const first = await confirm(kv, keys, await createPending(kv, keys, req(emailOnly), t.now()), t.now(), ack(emailOnly));
    for (let i = 0; i < 5; i++) {
      const c = both(newCredHash());
      await confirm(kv, keys, await createPending(kv, keys, req(c), t.now()), t.now(), ack(c));
    }
    const sixth = both(newCredHash());
    expect((await confirm(kv, keys, await createPending(kv, keys, req(sixth), t.now()), t.now(), ack(sixth))).status).toBe('full');
    t.advance(49 * 3600_000);
    const later = both(newCredHash());
    expect(await confirm(kv, keys, await createPending(kv, keys, req(later), t.now()), t.now(), ack(later))).toMatchObject({ channels: { push: 'bound' } });
    expect(await listDevices(kv, idOf(first))).toHaveLength(1);
  });

  it('lets an abandoned sign-up leave nothing but a stale pending-channels member once its links expire', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    await createPending(kv, keys, req(pushOnly(newCredHash())), t.now());
    t.advance(50 * 3600_000);
    expect(kv.keys().filter((k) => !k.startsWith('pp:rate') && k !== K.pendingChannels)).toEqual([]);
    // The stale member points at a pending record that no longer exists; push-downgrade (Task 11) skips and removes it.
    expect(await kv.sMembers(K.pendingChannels)).toHaveLength(1);
  });
});

async function indexOf(kv: Kv, id: string) {
  return (await kv.hGetAll(K.subscriber(id))).index!;
}
