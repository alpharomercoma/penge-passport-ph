import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { deviceCleanup } from '../src/devices/cleanup.ts';
import { acquireLock } from '../src/devices/lock.ts';
import { claim, sendGate } from '../src/devices/scripts-delivery.ts';
import { turnOff } from '../src/devices/scripts-api.ts';
import { ALERT_UNITS } from '../src/devices/store.ts';
import { silentLog } from '../src/log.ts';
import { choices, opId, seedAlert } from './device-fixtures.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
type Kv = Parameters<typeof claim>[0];
const run = (kv: Kv, runId: string, now = T0 + 60_000) => {
  return kv.set(K.checkLock, runId).then(() => deviceCleanup({ kv, log: silentLog, now: () => now, stampNow: () => ({ wall: now }) }, runId));
};

async function claimed(kv: Kv, runId: string, sending: boolean) {
  const a = await seedAlert(kv, { now: T0, order: 0, choices: choices() });
  const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
  await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [a.id]: JSON.stringify({ i: a.id, n: inc, s: [{ wall: T0 }], d: [[486, '2026-10-09', 1, 0]] }) } }]);
  await kv.set(K.checkLock, runId);
  const cid = opId();
  await claim(kv, { now: T0 + 1000, run: runId, id: a.id, cid, stamp: { wall: T0 + 1000 }, day: '2026-10-06', cap: 3, batch: 'domestic', open: { '486|1': { d: ['2026-10-09'], at: T0 } }, abroad: {} });
  if (sending) await sendGate(kv, { now: T0 + 1000, run: runId, id: a.id, cid, stamp: { wall: T0 + 1000 }, modeOk: true, svc: 'fcm' });
  return a;
}

for (const [name, make] of valkeyTargets()) {
  describe(`clean-up on ${name}`, () => {
    it('puts back a claim a lost run left claimed, unattempted', async () => {
      const kv = await make();
      const a = await claimed(kv, 'old', false);
      const r = await run(kv, 'new');
      expect(r.recovered).toBe(1);
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual({});
      expect(await kv.get(K.devToday(a.id, '2026-10-06'))).toBe('0');
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-09', 1, 0]]);
    });

    it('settles a claim a lost run left sending as uncertain: deleted, count kept, never sent again', async () => {
      const kv = await make();
      const a = await claimed(kv, 'old', true);
      const r = await run(kv, 'new');
      expect(r.uncertain).toBe(1);
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual({});
      expect(await kv.get(K.devToday(a.id, '2026-10-06'))).toBe('1');
      expect(await kv.get(K.devHeld(a.id))).toBeNull();
    });

    it('removes a deleted alert\'s delivery keys and releases its units', async () => {
      const kv = await make();
      const a = await claimed(kv, 'old', false);
      await turnOff(kv, { now: T0, cred: a.hash });
      expect((await kv.hGetAll(K.devGarbage))[a.id]).toBe(String(ALERT_UNITS));
      const r = await run(kv, 'new');
      expect(r.garbage).toBe(1);
      for (const key of [K.devClaim(a.id), K.devLast(a.id), K.devTried(a.id), K.devHeld(a.id), K.devToday(a.id, '2026-10-06')]) {
        expect(await kv.script({ name: 'x', lua: "#!lua\nreturn tostring(redis.call('EXISTS', KEYS[1]))" }, [key], [])).toBe('0');
      }
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ units: '0', alerts: '0' });
    });

    it('drops queued and held dates past their window, and work of another incarnation', async () => {
      const kv = await make();
      const a = await seedAlert(kv, { now: T0, order: 0 });
      const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
      await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [a.id]: JSON.stringify({ i: a.id, n: 'old-incarnation', s: [{ wall: T0 }], d: [[486, '2026-10-09', 1, 0]] }) } }]);
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: inc, s: [{ wall: T0 - 4 * 3600_000 }, { wall: T0 }], d: [[486, '2026-10-10', 1, 0], [486, '2026-10-11', 1, 1]] }));
      const r = await run(kv, 'new');
      expect(r.pruned).toBe(2);
      expect(await kv.hGetAll(K.devQueue)).toEqual({});
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-11', 1, 0]]);
    });

    it('expires a fan-out batch past its window even when no notification pass runs', async () => {
      const kv = await make();
      await kv.set(K.checkLock, 'old');
      const { queueWrite } = await import('../src/devices/scripts-delivery.ts');
      await queueWrite(kv, { now: T0, run: 'old', mark: 'm', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [{ wall: T0 - 4 * 3600_000 }] } });
      const r = await run(kv, 'new');
      expect(r.fanoutExpired).toBe(1);
      expect(await kv.get(K.devFanoutStamps('b1'))).toBeNull();
    });

    it('recounts once a day and agrees with the units kept', async () => {
      const kv = await make();
      await claimed(kv, 'old', false);
      const r = await run(kv, 'new');
      expect(r.recount).toEqual({ units: ALERT_UNITS, expectedUnits: ALERT_UNITS, alerts: 1, expectedAlerts: 1 });
      expect((await run(kv, 'newer')).recount).toBeNull();
    });

    it('a device-cleanup run never touches a checker run\'s claims: it stops while the checker\'s lock is held', async () => {
      const kv = await make();
      const a = await claimed(kv, 'checker-run', false);
      const claimRec = await kv.hGetAll(K.devClaim(a.id));
      // The checker took its lock after device-cleanup looked, and device-cleanup has taken its own.
      await acquireLock(kv, 'cleanup-late', 300);
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0 + 60_000, stampNow: () => ({ wall: T0 + 60_000 }) }, 'cleanup-late')).rejects.toThrow();
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual(claimRec);
    });

    it('expires fan-out batches all or nothing: a batch whose stamps are not stamps has no known age and goes too', async () => {
      const kv = await make();
      await kv.set(K.checkLock, 'old');
      const { queueWrite } = await import('../src/devices/scripts-delivery.ts');
      await queueWrite(kv, { now: T0, run: 'old', mark: 'm1', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [{ wall: T0 - 4 * 3600_000 }] } });
      await queueWrite(kv, { now: T0, run: 'old', mark: 'm2', ops: [], batch: { id: 'b2', entries: ['486|2026-10-09|1|0'], stamps: [{ wall: T0 }] } });
      await kv.set(K.devFanoutStamps('b2'), JSON.stringify({ order: 1, stamps: [{}] }));
      const r = await run(kv, 'new');
      expect(r.fanoutExpired).toBe(2);
      expect([await kv.get(K.devFanoutStamps('b1')), await kv.get(K.devFanoutStamps('b2'))]).toEqual([null, null]);
    });

    it('sweeps nothing when any alert in its chunk is damaged: the first alert\'s work is kept too', async () => {
      const kv = await make();
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) ids.push((await seedAlert(kv, { now: T0, order: 0 })).id);
      ids.sort();
      const inc = (await kv.hGetAll(K.devAlert(ids[0]!))).inc!;
      const old = JSON.stringify({ i: ids[0], n: inc, s: [{ wall: T0 - 4 * 3600_000 }], d: [[486, '2026-10-09', 1, 0]] });
      await kv.write([
        { op: 'hSet', key: K.devQueue, fields: { [ids[0]!]: old } },
        { op: 'hDel', key: K.devAlert(ids[1]!), fields: ['offices'] },
      ]);
      await expect(run(kv, 'new')).rejects.toThrow(/offices/);
      expect((await kv.hGetAll(K.devQueue))[ids[0]!]).toBe(old);
    });

    it('recovers nothing when any claim in its chunk lacks a field put back writes', async () => {
      const kv = await make();
      const a = await claimed(kv, 'old', false);
      const b = await claimed(kv, 'old', false);
      const [first, second] = [a.id, b.id].sort();
      await kv.write([{ op: 'hDel', key: K.devClaim(second!), fields: ['prev'] }]);
      await kv.set(K.devLast(second!), (await kv.hGetAll(K.devClaim(second!))).at!);
      const before = await kv.hGetAll(K.devClaim(first!));
      await expect(run(kv, 'new')).rejects.toThrow(/claim/);
      expect(await kv.hGetAll(K.devClaim(first!))).toEqual(before);
    });

    it('does nothing without the lock', async () => {
      const kv = await make();
      await claimed(kv, 'old', false);
      await kv.set(K.checkLock, 'someone-else');
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0, stampNow: () => ({ wall: T0 }) }, 'me')).rejects.toThrow(/lost the checker lock/);
    });

    it('a device-cleanup run killed while holding its lock never stops the checker from running', async () => {
      const kv = await make();
      // A cleanup that took its lock and was then killed (no release): its lock stays until its TTL ...
      expect(await acquireLock(kv, 'cleanup-hung', 300)).toBe(true);
      expect(await kv.get(K.devCleanupLock)).toBe('cleanup-hung');
      // ... and the checker's lock is untouched: the next (older or newer) checker run takes it at once.
      expect(await acquireLock(kv, 'r-next', 300)).toBe(true);
      expect(await kv.get(K.checkLock)).toBe('r-next');
      // A cleanup run is fenced by its own lock, and stops while a checker holds the checker's (Codex, Task 12: it
      // must never take a live run's claims for abandoned ones); with no checker running it works.
      await kv.write([{ op: 'del', key: K.devCleanupLock }]);
      await acquireLock(kv, 'cleanup-live', 300);
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0, stampNow: () => ({ wall: T0 }) }, 'cleanup-live')).rejects.toThrow();
      await kv.write([{ op: 'del', key: K.checkLock }]);
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0, stampNow: () => ({ wall: T0 }) }, 'cleanup-live')).resolves.toBeTruthy();
      // And it stops when it no longer holds it.
      await kv.set(K.devCleanupLock, 'cleanup-other');
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0, stampNow: () => ({ wall: T0 }) }, 'cleanup-live')).rejects.toThrow();
    });
  });
}
