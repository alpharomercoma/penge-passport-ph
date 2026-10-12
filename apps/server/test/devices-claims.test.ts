import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { claim, type ClaimInput, sendGate, settle, workList } from '../src/devices/scripts-delivery.ts';
import { choices, opId, seedAlert } from './device-fixtures.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const DAY = '2026-10-06';
type Kv = Parameters<typeof claim>[0];

async function withWork(kv: Kv, o: { pace?: 'asap' | 'hourly'; dates?: string[]; wall?: number; office?: number } = {}) {
  const a = await seedAlert(kv, { now: T0, order: 0, choices: choices({ siteIds: [o.office ?? 486], pace: o.pace ?? 'asap' }) });
  const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
  const dates = o.dates ?? ['2026-10-09'];
  await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [a.id]: JSON.stringify({ i: a.id, n: inc, s: [{ wall: o.wall ?? T0 }], d: dates.map((d) => [o.office ?? 486, d, 1, 0]) }) } }]);
  await kv.set(K.checkLock, 'r1');
  return { ...a, inc };
}
const input = (id: string, o: Partial<ClaimInput> = {}): ClaimInput => ({
  now: T0 + 1000, run: 'r1', id, cid: opId(), stamp: { wall: T0 + 1000 }, day: DAY, cap: 3, batch: 'domestic',
  open: { '486|1': { d: ['2026-10-09'], at: T0 + 500 } }, abroad: {}, ...o,
});

for (const [name, make] of valkeyTargets()) {
  describe(`claims on ${name}`, () => {
    it('claims only dates verified open in this run, charges the day and sets the pace stamp', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: ['2026-10-09', '2026-10-10'] });
      const c = input(a.id);
      const r = await claim(kv, c);
      // The push service of the generation claimed, read in the same step: the gate and settlement use it.
      expect(r).toMatchObject({ ok: true, checked: T0 + 500, svc: 'fcm', job: { d: [[486, '2026-10-09', 1, 0]] } });
      expect(await kv.get(K.devToday(a.id, DAY))).toBe('1');
      expect(JSON.parse((await kv.get(K.devLast(a.id)))!)).toEqual({ wall: T0 + 1000 });
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-10', 1, 0]]); // the rest waits
      expect(await kv.hGetAll(K.devQueue)).toEqual({});
      expect(await claim(kv, input(a.id))).toEqual({ ok: false, why: 'claimed' });
    });

    it.each([
      ['its pace', async (kv: Kv, id: string) => kv.set(K.devLast(id), JSON.stringify({ wall: T0 })), 'pace'],
      ['its daily cap', async (kv: Kv, id: string) => kv.set(K.devToday(id, DAY), '3'), 'cap'],
      ['an attempt already this run', async (kv: Kv, id: string) => kv.write([{ op: 'hSet', key: K.devTried(id), fields: { run: 'r1' } }]), 'attempted'],
    ])('refuses for %s, keeping the work held with its original time', async (_, prepare, why) => {
      const kv = await make();
      const a = await withWork(kv);
      await prepare(kv, a.id);
      expect(await claim(kv, input(a.id))).toEqual({ ok: false, why });
      if (why !== 'attempted') expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).s).toEqual([{ wall: T0 }]);
    });

    it('drops dates past their 3-hour window and dates whose age cannot be known', async () => {
      const kv = await make();
      const a = await withWork(kv, { wall: T0 - 3 * 3600_000 - 1 });
      expect(await claim(kv, input(a.id))).toEqual({ ok: false, why: 'empty' });
      const b = await withWork(kv, { office: 486 });
      await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [b.id]: JSON.stringify({ i: b.id, n: b.inc, s: [{ wall: T0, up: 5, boot: 'old' }], d: [[486, '2026-10-09', 1, 0]] }) } }]);
      expect(await claim(kv, input(b.id, { stamp: { wall: T0 + 1000, up: 9, boot: 'new' } }))).toEqual({ ok: false, why: 'empty' });
      expect((await kv.hGetAll(K.statsV2(DAY))).dates_dropped_unknown_age).toBe('1');
    });

    it('in the domestic batch, defers an alert whose oldest waiting date is abroad and older', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: ['2026-10-09'] });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: a.inc, s: [{ wall: T0 - 60_000 }], d: [[9001, '2026-10-20', 1, 0]] }));
      await kv.write([{ op: 'hSet', key: K.devAlert(a.id), fields: { offices: '486,9001' } }]);
      expect(await claim(kv, input(a.id, { abroad: { '9001': true } }))).toEqual({ ok: false, why: 'deferred' });
      // The abroad batch sends both.
      const r = await claim(kv, input(a.id, { batch: 'abroad', abroad: { '9001': true }, open: { '486|1': { d: ['2026-10-09'], at: T0 }, '9001|1': { d: ['2026-10-20'], at: T0 } } }));
      expect(r.ok && r.job.d).toHaveLength(2);
    });

    it('puts a claim back unattempted when the gate fails, restoring count and pace, without a try', async () => {
      const kv = await make();
      const a = await withWork(kv);
      await kv.set(K.devLast(a.id), JSON.stringify({ wall: T0 - 3600_000 }));
      const c = input(a.id);
      await claim(kv, c);
      await kv.set(K.pushPaused, '1');
      expect(await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' })).toEqual({ go: false, why: 'paused' });
      expect(await kv.get(K.devToday(a.id, DAY))).toBe('0');
      expect(JSON.parse((await kv.get(K.devLast(a.id)))!)).toEqual({ wall: T0 - 3600_000 });
      expect(await kv.hGetAll(K.devTried(a.id))).toEqual({});
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-09', 1, 0]]);
    });

    it('passes the gate once, with the sealed subscription, and moves the claim to sending', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      const g = await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      expect(g).toMatchObject({ go: true, sub: expect.stringMatching(/^v2\./) });
      expect((await kv.hGetAll(K.devClaim(a.id))).state).toBe('sending');
      expect(await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' })).toMatchObject({ go: false });
    });

    it.each([
      ['accepted', { claim: false, today: '1', held: false }],
      ['uncertain', { claim: false, today: '1', held: false }],
      ['bug', { claim: false, today: '0', held: false }],
      ['refused', { claim: false, today: '0', held: true }],
      ['throttled', { claim: false, today: '0', held: true }],
      ['rejected', { claim: false, today: '0', held: true }],
    ] as const)('settles %s', async (result, want) => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      expect(await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: opId(), stamp: c.stamp, result, backoffUntil: null })).toEqual({ ok: false });
      expect((await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, result, backoffUntil: result === 'throttled' ? T0 + 60_000 : null })).ok).toBe(true);
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual({});
      expect(await kv.get(K.devToday(a.id, DAY))).toBe(want.today);
      expect((await kv.get(K.devHeld(a.id))) !== null).toBe(want.held);
      if (want.held) expect((await kv.hGetAll(K.devTried(a.id)))['486|2026-10-09|1']).toBe('1');
      if (result === 'throttled') expect(await kv.get(K.pushBackoff('fcm'))).toBe(String(T0 + 60_000));
    });

    it('settles gone for the current generation by deleting the alert, keeping no work', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      expect(await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, result: 'gone', backoffUntil: null })).toEqual({ ok: true, outcome: 'deleted' });
      expect(await kv.hGetAll(K.devAlert(a.id))).toEqual({});
      expect(await kv.hGetAll(K.devEnded(a.hash))).toMatchObject({ reason: 'gone' });
    });

    it('stops at a damaged pace choice before changing anything, the queued work kept', async () => {
      const kv = await make();
      const a = await withWork(kv);
      await kv.write([{ op: 'hSet', key: K.devAlert(a.id), fields: { pace: 'daily' } }]);
      await kv.set(K.devLast(a.id), JSON.stringify({ wall: T0 }));
      const queue = await kv.hGetAll(K.devQueue);
      await expect(claim(kv, input(a.id))).rejects.toThrow(/pace/);
      expect(await kv.hGetAll(K.devQueue)).toEqual(queue);
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual({});
    });

    it.each([
      ['a refused send', 'settle'],
      ['a gate that fails', 'gate'],
    ] as const)('puts back nothing at all when the charged counter is damaged, for %s', async (_, step) => {
      const kv = await make();
      const a = await withWork(kv, { dates: ['2026-10-09', '2026-10-10'] });
      const c = input(a.id);
      expect((await claim(kv, c)).ok).toBe(true);
      if (step === 'settle') await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      await kv.set(K.devToday(a.id, DAY), '1.5');
      const held = await kv.get(K.devHeld(a.id));
      const claimRec = await kv.hGetAll(K.devClaim(a.id));
      const tried = await kv.hGetAll(K.devTried(a.id));
      const run = step === 'settle'
        ? settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, result: 'refused', backoffUntil: null })
        : sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: false, svc: 'fcm' });
      await expect(run).rejects.toThrow(/counter|integer/);
      expect([await kv.get(K.devHeld(a.id)), await kv.hGetAll(K.devClaim(a.id)), await kv.hGetAll(K.devTried(a.id))]).toEqual([held, claimRec, tried]);
    });

    it('drops a date after its third refused try', async () => {
      const kv = await make();
      const a = await withWork(kv);
      for (let i = 0; i < 3; i++) {
        const c = input(a.id, { run: `r${i}` });
        await kv.set(K.checkLock, `r${i}`);
        await kv.set(K.devLast(a.id), JSON.stringify({ wall: 0 })); // pace allows
        expect((await claim(kv, c)).ok).toBe(true);
        await sendGate(kv, { now: T0 + 1000, run: `r${i}`, id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
        await settle(kv, { now: T0 + 2000, run: `r${i}`, id: a.id, cid: c.cid, stamp: c.stamp, result: 'refused', backoffUntil: null });
      }
      expect(await kv.get(K.devHeld(a.id))).toBeNull();
      expect((await kv.hGetAll(K.statsV2(DAY))).dates_dropped_tries).toBe('1');
    });

    it('never settles for a run that lost the lock: the claim stays for the next run to recover', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      await kv.set(K.checkLock, 'r2');
      expect(await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, result: 'refused', backoffUntil: null })).toEqual({ ok: false });
      expect((await kv.hGetAll(K.devClaim(a.id))).state).toBe('sending');
    });

    it('bounds the merged held and queued work before claiming: at most 30 dates', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`) });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: a.inc, s: [{ wall: T0 - 1000 }], d: Array.from({ length: 30 }, (_, i) => [486, `2026-12-${String(i + 1).padStart(2, '0')}`, 1, 0]) }));
      const all = [...Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 30 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`)];
      const r = await claim(kv, input(a.id, { open: { '486|1': { d: all, at: T0 } } }));
      expect(r.ok && r.job.d.length).toBe(30);
      expect((await kv.hGetAll(K.statsV2(DAY))).dates_dropped_overflow).toBe('30');
    });

    it('stops at a damaged pace stamp before changing anything', async () => {
      const kv = await make();
      const a = await withWork(kv);
      await kv.set(K.devLast(a.id), 'not json');
      await expect(claim(kv, input(a.id))).rejects.toThrow(/pace stamp/);
      expect(Object.keys(await kv.hGetAll(K.devQueue))).toEqual([a.id]);
    });

    it('stops at a pace stamp with a wrong uptime, or a run stamp without a wall time, before changing anything', async () => {
      const kv = await make();
      const a = await withWork(kv);
      await kv.set(K.devLast(a.id), JSON.stringify({ wall: T0 - 1000, up: 'x', boot: 'b' }));
      await expect(claim(kv, input(a.id))).rejects.toThrow(/pace stamp/);
      await kv.write([{ op: 'del', key: K.devLast(a.id) }]);
      await expect(claim(kv, input(a.id, { stamp: { up: 5, boot: 'b' } as never }))).rejects.toThrow(/stamp/);
      expect(Object.keys(await kv.hGetAll(K.devQueue))).toEqual([a.id]);
    });

    it('treats held work whose date points at no stamp as no work', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: [] });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: a.inc, s: [{ wall: T0 - 1000 }], d: [[486, '2026-12-01', 1, 3]] }));
      expect(await claim(kv, input(a.id))).toMatchObject({ ok: false });
    });

    it('lists the alerts with work, sorted', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const b = await withWork(kv);
      expect(await workList(kv)).toEqual([a.id, b.id].sort());
    });
  });
}
