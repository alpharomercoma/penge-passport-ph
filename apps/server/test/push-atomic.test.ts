import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { connectRedis, type Kv, MemoryKv, type WriteOp } from '../src/kv.ts';
import { findDevice } from '../src/push/register.ts';
import { MAX_DEVICES, parseMeta, PROVISIONAL_TTL_SECONDS, pushBind, pushRegister, pushRemove, revokeCredential } from '../src/push/atomic.ts';

const ttl = (kv: Kv, key: string) =>
  kv.script({ name: 'ttl', lua: "return tostring(redis.call('TTL', KEYS[1]))", memory: (tx, k) => String(tx.ttl(k[0]!)) }, [key], []).then(Number);

async function disposableValkey(url: string): Promise<Kv> {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1') throw new Error('PUSH_TEST_VALKEY must be a local throwaway Valkey on 127.0.0.1');
  const kv = await connectRedis(url, () => {});
  if ((await kv.get(K.pushTestMark)) !== '1') throw new Error('this Valkey is not marked disposable; refusing to wipe it');
  await kv.script({ name: 'wipe', lua: "redis.call('FLUSHDB') redis.call('SET', KEYS[1], '1') return 'ok'", memory: () => 'ok' }, [K.pushTestMark], []);
  return kv;
}

const targets: [string, () => Promise<Kv>][] = [['MemoryKv', async () => new MemoryKv()]];
if (process.env.PUSH_TEST_VALKEY) targets.push(['Valkey', () => disposableValkey(process.env.PUSH_TEST_VALKEY!)]);

const subscriber = (kv: Kv, ...ids: string[]) => kv.write(ids.map((id) => ({ op: 'hSet' as const, key: K.subscriber(id), fields: { email: 'x' } })));
const bind = (kv: Kv, sub: string, dev: string, cred: string) =>
  pushBind(kv, { subscriberId: sub, deviceId: dev, credentialHash: cred, sealedAwaiting: 'v2.awaiting', addressIndex: 'idx', provisionalTtlSeconds: PROVISIONAL_TTL_SECONDS, maxDevices: MAX_DEVICES });
const register = (kv: Kv, sub: string, dev: string, revision: number, ep: string, sh: string) =>
  pushRegister(kv, { subscriberId: sub, deviceId: dev, revision, endpointHmac: ep, subscriptionHmac: sh, sealed: `v2.${ep}${sh}` });
const remove = (kv: Kv, sub: string, dev: string, o: { revoke?: boolean; only?: string; awaiting?: boolean } = {}) =>
  pushRemove(kv, { subscriberId: sub, deviceId: dev, revokeSeconds: o.revoke ? 3600 : 0, onlyIfEndpointHmac: o.only ?? null, ...(o.awaiting ? { onlyIfAwaiting: true } : {}) });

for (const [name, make] of targets) {
  describe(`push devices on ${name}`, () => {
    it('binds a credential once, keeps it for the same owner, refuses another owner', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('bound');
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('kept');
      expect(await bind(kv, 'B', 'd2', 'c1')).toBe('owned');
      expect(parseMeta((await kv.hGetAll(K.pushMeta('A'))).d1!)).toMatchObject({ state: 'a', credentialHash: 'c1' });
    });

    it('never binds a revoked credential', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      await revokeCredential(kv, 'c1', 3600);
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('revoked');
      expect(await bind(kv, 'B', 'd2', 'c1')).toBe('revoked');
      expect(await kv.get(K.pushCred('c1'))).toBeNull();
    });

    it('turns a device off and revokes its credential in one step, so no other subscriber can take it', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      await bind(kv, 'A', 'd1', 'c1');
      expect(await remove(kv, 'A', 'd1', { revoke: true })).toBe('removed');
      expect(await bind(kv, 'B', 'd2', 'c1')).toBe('revoked');
    });

    it('lets two subscribers race for one credential and gives it to exactly one', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      const results = await Promise.all([bind(kv, 'A', 'd1', 'c1'), bind(kv, 'B', 'd2', 'c1')]);
      expect(results.sort()).toEqual(['bound', 'owned']);
    });

    it('gives a device of a subscriber that does not exist yet a limited life, and extends the reservation', async () => {
      const kv = await make();
      await kv.set(K.reserved('idx'), 'A', { ttlSeconds: 60 });
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('bound');
      for (const key of [K.pushMeta('A'), K.pushDevices('A'), K.pushCred('c1'), K.reserved('idx'), K.pushAddress('A')]) {
        expect(await ttl(kv, key)).toBeGreaterThan(PROVISIONAL_TTL_SECONDS - 5);
      }
    });

    it('keeps every device of a subscriber that does not exist yet alive together, credentials included', async () => {
      const kv = await make();
      await kv.set(K.reserved('idx'), 'A', { ttlSeconds: 60 });
      const bindFor = (dev: string, cred: string, ttlSeconds: number) =>
        pushBind(kv, { subscriberId: 'A', deviceId: dev, credentialHash: cred, sealedAwaiting: 'v2.awaiting', addressIndex: 'idx', provisionalTtlSeconds: ttlSeconds, maxDevices: MAX_DEVICES });
      expect(await bindFor('d1', 'c1', 100)).toBe('bound');
      expect(await bindFor('d2', 'c2', 1000)).toBe('bound');
      for (const key of [K.pushCred('c1'), K.pushCred('c2'), K.pushMeta('A'), K.pushDevices('A'), K.pushAddress('A'), K.reserved('idx')]) {
        expect(await ttl(kv, key)).toBeGreaterThan(990);
      }
    });

    it('extends a reservation that ends a moment sooner, and never gives one without an end an expiry', async () => {
      const kv = await make();
      // 300 ms short of the provisional life: whole seconds would read it as equal.
      const pset = (key: string, ms: number) =>
        kv.script({ name: 'pset', lua: "redis.call('SET', KEYS[1], 'A', 'PX', ARGV[1]) return 'ok'", memory: (tx, k, a) => (tx.set(k[0]!, 'A'), tx.expire(k[0]!, Number(a[0]) / 1000), 'ok') }, [key], [String(ms)]);
      await pset(K.reserved('idx'), PROVISIONAL_TTL_SECONDS * 1000 - 300);
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('bound');
      const pttl = await kv.script({ name: 'pttl', lua: "return tostring(redis.call('PTTL', KEYS[1]))", memory: (tx, k) => String(tx.pttl(k[0]!)) }, [K.reserved('idx')], []);
      expect(Number(pttl)).toBeGreaterThan(PROVISIONAL_TTL_SECONDS * 1000 - 100);
      await kv.set(K.reserved('idx2'), 'B');
      await pushBind(kv, { subscriberId: 'B', deviceId: 'd1', credentialHash: 'c9', sealedAwaiting: 'v2.awaiting', addressIndex: 'idx2', provisionalTtlSeconds: PROVISIONAL_TTL_SECONDS, maxDevices: MAX_DEVICES });
      expect(await ttl(kv, K.reserved('idx2'))).toBe(-1);
    });

    it('never puts a new credential on a device slot that holds another one', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      await register(kv, 'A', 'd1', 1, 'e1', 's1');
      expect(await bind(kv, 'A', 'd1', 'c2')).toBe('owned');
      expect(parseMeta((await kv.hGetAll(K.pushMeta('A'))).d1!)).toMatchObject({ state: 'r', credentialHash: 'c1', endpointHmac: 'e1' });
      expect(await kv.get(K.pushCred('c2'))).toBeNull();
    });

    it('reads a stray non-owner value under a credential key the same way on both stores', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await kv.pfAdd(K.pushCred('c1'), 'x', 3600);
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('bound');
      expect(await kv.get(K.pushCred('c1'))).toBe('A/d1');
    });

    it('reads an owner with no device part as no owner, on both stores', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      await kv.write([{ op: 'set', key: K.pushCred('c1'), value: 'A/' }, { op: 'hSet', key: K.pushMeta('A'), fields: { '': 'a|0|c1||' } }]);
      expect(await bind(kv, 'B', 'd1', 'c1')).toBe('bound');
    });

    it('clears a credential entry naming no device at all, on both stores', async () => {
      const kv = await make();
      // Even when the store holds a field that would match the empty device part.
      await kv.write([{ op: 'hSet', key: K.pushMeta('A'), fields: { '': 'a|0|c1||' } }, { op: 'hSet', key: K.pushMeta(''), fields: { d1: 'a|0|c1||' } }]);
      for (const owner of ['A/', '/d1', 'nodevice']) {
        await kv.set(K.pushCred('c1'), owner);
        expect(await findDevice(kv, 'c1')).toBeNull();
        expect(await kv.get(K.pushCred('c1'))).toBeNull();
      }
    });

    it('refuses a sixth device', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      for (let i = 0; i < MAX_DEVICES; i++) expect(await bind(kv, 'A', `d${i}`, `c${i}`)).toBe('bound');
      expect(await bind(kv, 'A', 'd9', 'c9')).toBe('full');
    });

    it('registers by revision: higher applies, same is a repeat, lower or same-with-new-keys is stale', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's1')).toBe('registered');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's1')).toBe('registered');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's2')).toBe('stale');
      expect(await register(kv, 'A', 'd1', 2, 'e2', 's3')).toBe('registered');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's1')).toBe('stale');
      expect(await kv.get(K.pushEndpoint('e1'))).toBeNull();
      expect(await kv.get(K.pushEndpoint('e2'))).toBe('A/d1');
    });

    it('gives an endpoint one owner even when two subscribers register it at once', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      await bind(kv, 'A', 'd1', 'c1');
      await bind(kv, 'B', 'd2', 'c2');
      const results = await Promise.all([register(kv, 'A', 'd1', 1, 'e1', 's1'), register(kv, 'B', 'd2', 1, 'e1', 's1')]);
      expect(results.sort()).toEqual(['endpoint-taken', 'registered']);
    });

    it('frees an endpoint whose owner no longer exists', async () => {
      const kv = await make();
      await subscriber(kv, 'B');
      await kv.set(K.pushEndpoint('e1'), 'GONE/d0');
      await bind(kv, 'B', 'd2', 'c2');
      expect(await register(kv, 'B', 'd2', 1, 'e1', 's1')).toBe('registered');
    });

    it('a late 410 removes a device only if it still has the endpoint that was sent to', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      await register(kv, 'A', 'd1', 1, 'e1', 's1');
      await register(kv, 'A', 'd1', 2, 'e2', 's2');
      expect(await remove(kv, 'A', 'd1', { only: 'e1' })).toBe('kept');
      expect(await remove(kv, 'A', 'd1', { only: 'e2' })).toBe('removed');
      expect(await kv.get(K.pushEndpoint('e2'))).toBeNull();
      expect(await kv.get(K.pushCred('c1'))).toBeNull();
      expect(await kv.hGetAll(K.pushDevices('A'))).toEqual({});
    });

    it('removes an awaiting device only while it is still awaiting', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      await register(kv, 'A', 'd1', 1, 'e1', 's1');
      expect(await remove(kv, 'A', 'd1', { awaiting: true })).toBe('kept');
    });

    it('turns push off on the subscriber in the same step that removes its last device', async () => {
      const kv = await make();
      await kv.write([{ op: 'hSet', key: K.subscriber('A'), fields: { email: 'x', pushOn: '1' } }]);
      await bind(kv, 'A', 'd1', 'c1');
      await bind(kv, 'A', 'd2', 'c2');
      await remove(kv, 'A', 'd1');
      expect((await kv.hGetAll(K.subscriber('A'))).pushOn).toBe('1');
      await remove(kv, 'A', 'd2');
      expect((await kv.hGetAll(K.subscriber('A'))).pushOn).toBe('0');
      await remove(kv, 'B', 'd9'); // no subscriber: nothing is created
      expect(await kv.hGetAll(K.subscriber('B'))).toEqual({});
    });

    it('is a no-op when repeated after success (a lost answer)', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      await register(kv, 'A', 'd1', 1, 'e1', 's1');
      expect(await remove(kv, 'A', 'd1')).toBe('removed');
      expect(await remove(kv, 'A', 'd1')).toBe('missing');
    });

    it('refuses bad input before writing anything', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      const before = JSON.stringify([await kv.hGetAll(K.pushMeta('A')), await kv.get(K.pushCred('c1'))]);
      await expect(pushRegister(kv, { subscriberId: 'A', deviceId: 'd|1', revision: 1, endpointHmac: 'e', subscriptionHmac: 's', sealed: 'v2.x' })).rejects.toThrow(/bad/);
      await expect(pushRegister(kv, { subscriberId: 'A', deviceId: 'd1', revision: -1, endpointHmac: 'e', subscriptionHmac: 's', sealed: 'v2.x' })).rejects.toThrow(/bad/);
      await expect(pushBind(kv, { subscriberId: 'A', deviceId: 'd2', credentialHash: 'c2', sealedAwaiting: 'v2.x', addressIndex: 'i', provisionalTtlSeconds: 0, maxDevices: 5 })).rejects.toThrow(/bad/);
      expect(JSON.stringify([await kv.hGetAll(K.pushMeta('A')), await kv.get(K.pushCred('c1'))])).toBe(before);
    });

    it('changes nothing when a key it would write has the wrong type', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await kv.set(K.pushDevices('A'), 'not a hash');
      await expect(bind(kv, 'A', 'd1', 'c1')).rejects.toThrow(/wrongtype/i);
      expect(await kv.get(K.pushCred('c1'))).toBeNull();
      expect(await kv.hGetAll(K.pushMeta('A'))).toEqual({});
    });
  });
}
