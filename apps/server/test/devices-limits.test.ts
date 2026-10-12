import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { charge, DEVICE_LIMITS, ingressBucket } from '../src/devices/limits.ts';
import type { Limit } from '../src/limits.ts';
import { clock } from './helpers.ts';
import { valkeyTargets } from './valkey.ts';

const small = (bucket: string, max: number): Limit => ({ bucket, max, windowSeconds: 3600 });

for (const [name, make] of valkeyTargets()) {
  describe(`all-or-nothing limits on ${name}`, () => {
    it('charges every limit, or none when one has no room, and creates nothing when refused', async () => {
      const kv = await make();
      const t = clock();
      const global = small('t-global', 2);
      const perIp = small('t-ip', 5);
      expect(await charge(kv, [[global, 'all'], [perIp, 'ip1']], t.now())).toEqual({ ok: true });
      expect(await charge(kv, [[global, 'all'], [perIp, 'ip2']], t.now())).toEqual({ ok: true });
      expect(await charge(kv, [[global, 'all'], [perIp, 'ip3']], t.now())).toEqual({ ok: false, refused: 't-global' });
      const keys = (await kv.script({ name: 'k', lua: "#!lua\nreturn cjson.encode(redis.call('EXISTS', KEYS[1]))" }, [`pp:rate:t-ip:${Math.floor(t.now() / 3_600_000)}:ip3`], []));
      expect(keys).toBe('0');
    });

    it('stops before taking anything when a counter is not canonical, even "-0" (which Lua 5.1 would print back as is)', async () => {
      const kv = await make();
      const t = clock();
      const first = small('t-first', 5);
      const second = small('t-second', 5);
      const win = Math.floor(t.now() / 3_600_000);
      await kv.set(`pp:rate:t-second:${win}:x`, '-0');
      await expect(charge(kv, [[first, 'x'], [second, 'x']], t.now())).rejects.toThrow(/not a counter/);
      expect(await kv.get(`pp:rate:t-first:${win}:x`)).toBeNull();
    });

    it('weighs the previous window by its overlap, as hit() does', async () => {
      const kv = await make();
      const t = clock(Date.parse('2026-10-06T00:00:00Z'));
      const l = small('t-slide', 4);
      for (let i = 0; i < 4; i++) expect((await charge(kv, [[l, 'x']], t.now())).ok).toBe(true);
      t.advance(3_600_000 + 900_000); // a quarter into the next window: 3 of the 4 still count
      expect((await charge(kv, [[l, 'x']], t.now())).ok).toBe(true);
      expect((await charge(kv, [[l, 'x']], t.now())).ok).toBe(false);
    });
  });
}

describe('the ingress gate', () => {
  it('spreads addresses over exactly 4,096 buckets, the same bucket for the same address', () => {
    const key = randomBytes(32);
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) {
      const b = ingressBucket(`198.51.${i >> 8}.${i & 255}`, key);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(4096);
      seen.add(b);
    }
    expect(seen.size).toBeGreaterThan(3900);
    expect(ingressBucket('2001:db8::1', key)).toBe(ingressBucket('2001:db8::ffff', key)); // one /64
  });

  it('has every class of the spec\'s limits table', () => {
    expect(DEVICE_LIMITS.ingress.max).toBe(3000);
    expect([DEVICE_LIMITS.unknownSetupIp.max, DEVICE_LIMITS.unknownSetupAll.max]).toEqual([30, 300]);
    expect([DEVICE_LIMITS.storedSetupIp.max, DEVICE_LIMITS.storedSetupAll.max]).toEqual([10, 100]);
    expect(DEVICE_LIMITS.setupPushEndpoint.max).toBe(3);
    expect([DEVICE_LIMITS.maintenanceAlert.max, DEVICE_LIMITS.maintenanceAll.max]).toEqual([6, 600]);
    expect([DEVICE_LIMITS.ackIp.max, DEVICE_LIMITS.ackAll.max]).toEqual([60, 7000]);
    expect([DEVICE_LIMITS.knownReadCred.max, DEVICE_LIMITS.knownReadIp.max, DEVICE_LIMITS.knownReadAll.max]).toEqual([600, 2400, 50_000]);
    expect([DEVICE_LIMITS.pendingReadCred.max, DEVICE_LIMITS.pendingReadIp.max, DEVICE_LIMITS.pendingReadAll.max]).toEqual([240, 1200, 15_000]);
    expect([DEVICE_LIMITS.changeCred.max, DEVICE_LIMITS.changeAll.max]).toEqual([60, 6000]);
    expect([DEVICE_LIMITS.offIp.max, DEVICE_LIMITS.offAll.max]).toEqual([600, 6000]);
    expect([DEVICE_LIMITS.unknownIp.max, DEVICE_LIMITS.unknownAll.max]).toEqual([600, 6000]);
    expect([DEVICE_LIMITS.testAlert.max, DEVICE_LIMITS.testIp.max, DEVICE_LIMITS.testAll.max]).toEqual([3, 20, 200]);
    for (const l of Object.values(DEVICE_LIMITS)) expect(l.windowSeconds).toBe(3600);
  });
});
