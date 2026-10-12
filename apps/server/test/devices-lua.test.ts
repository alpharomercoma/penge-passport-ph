/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { elapsed, type Stamp } from '../src/clock.ts';
import { DEVICE_SCRIPTS, deviceScript } from '../src/devices/lua.ts';
import { K } from '../src/keys.ts';
import { lintLua51 } from './lua-subset.ts';
import { valkeyTargets } from './valkey.ts';

// Every device module there is, so DEVICE_SCRIPTS holds every script (later tasks add modules; nothing to update here).
import.meta.glob('../src/devices/*.ts', { eager: true });

const echo = deviceScript('test-echo', `return cjson.encode({ a = K.a, b = A.b, now = NOW })`);
const prefixes = deviceScript(
  'test-prefixes',
  `return cjson.encode({ alert = KEY.alert .. 'x', today = KEY.today .. 'x:2026-10-06', stamps = KEY.fanout .. 'b1:stamps',
     site = KEY.site .. '486', op = KEY.op .. 'h', ended = KEY.ended .. 'h', backoff = KEY.backoff .. 'fcm',
     records = KEY.records, paused = KEY.paused, lock = KEY.lock, cursor = KEY.cursorAbroad })`,
);
const typed = deviceScript('test-typed', `need(K.h, 'hash') redis.call('SET', K.w, '1') return '"ok"'`);
const counted = deviceScript('test-count', `count('opsStarted') count('opsStarted', 2) return '"ok"'`);
const age = deviceScript('test-elapsed', `local e = elapsed(A.from, A.to) if e == nil then return '"unknown"' end return cjson.encode(e)`);

for (const [name, make] of valkeyTargets()) {
  describe(`device script prelude on ${name}`, () => {
    it('passes keys and arguments by name', async () => {
      const kv = await make();
      expect(await echo.run(kv, { a: 'pp:dev:x' }, { b: 'y"z', now: 1791261968326 })).toEqual({ a: 'pp:dev:x', b: 'y"z', now: 1791261968326 });
    });

    it('builds the same keys as keys.ts', async () => {
      const kv = await make();
      expect(await prefixes.run(kv, {}, { now: 0 })).toEqual({
        alert: K.devAlert('x'),
        today: K.devToday('x', '2026-10-06'),
        stamps: K.devFanoutStamps('b1'),
        site: K.devSite(486),
        op: K.devOp('h'),
        ended: K.devEnded('h'),
        backoff: K.pushBackoff('fcm'),
        records: K.devRecords,
        paused: K.pushPaused,
        lock: K.checkLock,
        cursor: K.devCursor('abroad'),
      });
    });

    it('checks key types before writing anything', async () => {
      const kv = await make();
      await kv.set('pp:dev:h', 'not a hash');
      await expect(typed.run(kv, { h: 'pp:dev:h', w: 'pp:dev:w' }, { now: 0 })).rejects.toThrow(/WRONGTYPE/);
      expect(await kv.get('pp:dev:w')).toBeNull();
    });

    it('counts into the day\'s versioned statistics, with an expiry', async () => {
      const kv = await make();
      await counted.run(kv, { stats: K.statsV2('2026-10-06') }, { now: 1791261968326 });
      expect(await kv.hGetAll(K.statsV2('2026-10-06'))).toEqual({ opsStarted: '3', since: '1791261968326' });
      const ttl = await deviceScript('test-ttl', `return cjson.encode(redis.call('TTL', K.s))`).run<number>(kv, { s: K.statsV2('2026-10-06') }, { now: 0 });
      expect(ttl).toBeGreaterThan(39 * 86400);
    });

    it('measures time between stamps exactly as clock.ts does', async () => {
      const kv = await make();
      const cases: [Stamp, Stamp][] = [
        [{ wall: 1000, up: 50, boot: 'a' }, { wall: 9000, up: 650, boot: 'a' }],
        [{ wall: 1000, up: 50, boot: 'a' }, { wall: 9000, up: 650, boot: 'b' }],
        [{ wall: 1000, up: 700, boot: 'a' }, { wall: 9000, up: 650, boot: 'a' }],
        [{ wall: 1000 }, { wall: 9000 }],
        [{ wall: 9000 }, { wall: 1000 }],
        [{ wall: 1000, up: 5, boot: 'a' }, { wall: 9000 }],
        [{ wall: 1000 }, { wall: 9000, up: 5, boot: 'a' }],
      ];
      for (const [then, now] of cases) {
        const expected = elapsed(then, now);
        expect(await age.run(kv, {}, { now: 0, from: then, to: now })).toEqual(expected === null ? 'unknown' : expected);
      }
    });
  });
}

describe('device scripts', () => {
  it('all compile (a reserved word as a field name, a typo in the Lua, fails here, not at its first use)', async () => {
    const { compileError } = await import('../dev/lua-engine.ts');
    for (const s of DEVICE_SCRIPTS) expect([s.def.name, await compileError(s.def.lua)]).toEqual([s.def.name, null]);
  });

  it('are all in the Lua 5.1 subset and the flagged form', async () => {
    expect(DEVICE_SCRIPTS.length).toBeGreaterThan(0);
    for (const s of DEVICE_SCRIPTS) expect([s.def.name, lintLua51(s.def.lua)]).toEqual([s.def.name, []]);
  });

  it('flags only reclamation scripts allow-oom', () => {
    const reclaim = deviceScript('test-reclaim', `return '"ok"'`, { reclaim: true });
    expect(reclaim.def.lua.split('\n')[0]).toBe('#!lua flags=allow-oom');
    expect(echo.def.lua.split('\n')[0]).toBe('#!lua');
  });
});
