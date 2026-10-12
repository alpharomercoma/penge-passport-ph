import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { fanoutChunk, heldPairs, LostLock, queueWrite } from '../src/devices/scripts-delivery.ts';
import { choices, seedAlert } from './device-fixtures.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const stamp = { wall: T0 };
const job = async (kv: Parameters<typeof queueWrite>[0], id: string) => JSON.parse((await kv.hGetAll(K.devQueue))[id] ?? 'null');
const lock = (kv: Parameters<typeof queueWrite>[0], run = 'r1') => kv.set(K.checkLock, run);

for (const [name, make] of valkeyTargets()) {
  describe(`queueing on ${name}`, () => {
    it('applies the email write and stores a fan-out batch in one step, only while the run holds the lock', async () => {
      const kv = await make();
      await lock(kv, 'other');
      const write = { now: T0, run: 'r1', mark: 'r1:domestic', ops: [{ op: 'set' as const, key: K.announced(486, 1, '2026-10-09'), value: '{}', ttlSeconds: 60 }], batch: { id: 'r1:domestic', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } };
      await expect(queueWrite(kv, write)).rejects.toThrow(LostLock);
      expect(await kv.get(K.announced(486, 1, '2026-10-09'))).toBeNull();
      await lock(kv);
      await queueWrite(kv, write);
      expect(await kv.get(K.announced(486, 1, '2026-10-09'))).toBe('{}');
      expect(JSON.parse((await kv.get(K.devFanoutStamps('r1:domestic')))!)).toEqual({ order: 1, stamps: [stamp] });
      // A retry of the same write (its answer lost) applies nothing twice.
      await queueWrite(kv, write);
      expect(await kv.script({ name: 'n', lua: "#!lua\nreturn tostring(redis.call('LLEN', KEYS[1]))" }, [K.devFanouts], [])).toBe('1');
    });

    it('checks everything before writing: a damaged order counter stops the write with nothing written, and the retry without the batch goes', async () => {
      const kv = await make();
      await lock(kv);
      await kv.set(K.devOrder, 'not a number');
      const write = { now: T0, run: 'r1', mark: 'r1:domestic', ops: [{ op: 'rPush' as const, key: K.outbox, values: ['job'] }], batch: { id: 'r1:domestic', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } };
      await expect(queueWrite(kv, write)).rejects.toThrow(/not a counter/);
      expect(await kv.lLen(K.outbox)).toBe(0);
      await queueWrite(kv, { ...write, batch: null });
      expect(await kv.lLen(K.outbox)).toBe(1);
    });

    it('applies what kv.write applies: a set replaces any type, an empty push or hash writes nothing, a delete frees the key for what follows', async () => {
      const kv = await make();
      await lock(kv);
      await kv.write([
        { op: 'hSet', key: 'pp:test:h', fields: { a: '1' } },
        { op: 'set', key: 'pp:test:s', value: 'x' },
        { op: 'hSet', key: 'pp:test:d', fields: { a: '1' } },
      ]);
      await queueWrite(kv, {
        now: T0, run: 'r1', mark: 'semantics', batch: null,
        ops: [
          { op: 'set', key: 'pp:test:h', value: 'now a string' },
          { op: 'rPush', key: 'pp:test:s', values: [] },
          { op: 'del', key: 'pp:test:d' },
          { op: 'set', key: 'pp:test:d', value: 'replaced' },
          { op: 'del', key: 'pp:test:s2' },
          { op: 'hSet', key: 'pp:test:s2', fields: { '1': '[]' } },
        ],
      });
      expect([await kv.get('pp:test:h'), await kv.get('pp:test:s'), await kv.get('pp:test:d')]).toEqual(['now a string', 'x', 'replaced']);
      expect(await kv.hGetAll('pp:test:s2')).toEqual({ '1': '[]' });
      // A push onto what the same write left a string is still refused, before anything is written.
      await expect(queueWrite(kv, { now: T0, run: 'r1', mark: 'mixed', batch: null, ops: [{ op: 'set', key: 'pp:test:m', value: 'v' }, { op: 'set', key: 'pp:test:n', value: 'v' }, { op: 'rPush', key: 'pp:test:n', values: ['x'] }] })).rejects.toThrow(/WRONGTYPE/);
      expect(await kv.get('pp:test:m')).toBeNull();
    });

    it('treats a stored job with a fractional or out-of-range stamp index as no job, and writes nothing before every job is ready', async () => {
      const kv = await make();
      await lock(kv);
      const a = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486] }) });
      const b = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486] }) });
      const inc = (await kv.hGetAll(K.devAlert(b.id))).inc!;
      await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [b.id]: JSON.stringify({ i: b.id, n: inc, s: [stamp, stamp], d: [[486, '2026-10-01', 1, 0.5]] }) } }]);
      await kv.script({ name: 'order', lua: "#!lua\nredis.call('SET', KEYS[1], '5') return 'ok'" }, [K.devOrder], []);
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'frac', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toMatchObject({ batch: 'b1', entries: 1 });
      expect((await job(kv, a.id)).d).toEqual([[486, '2026-10-09', 1, 0]]);
      expect((await job(kv, b.id)).d).toEqual([[486, '2026-10-09', 1, 0]]);
    });

    it('drops an entry whose stamp is not one, and a batch whose stamps cannot be read, so neither blocks the batches after it', async () => {
      const kv = await make();
      await lock(kv);
      const a = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486] }) });
      await kv.script({ name: 'order', lua: "#!lua\nredis.call('SET', KEYS[1], '5') return 'ok'" }, [K.devOrder], []);
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'bad-stamp', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'bad-meta', ops: [], batch: { id: 'b2', entries: ['486|2026-10-10|1|0'], stamps: [stamp] } });
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'good', ops: [], batch: { id: 'b3', entries: ['486|2026-10-11|1|0'], stamps: [stamp] } });
      await kv.set(K.devFanoutStamps('b1'), JSON.stringify({ order: 9, stamps: [{}] }));
      await kv.set(K.devFanoutStamps('b2'), 'not json');
      for (let i = 0; i < 3; i++) await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toEqual({ done: true });
      expect((await job(kv, a.id)).d).toEqual([[486, '2026-10-11', 1, 0]]);
      const stats = await kv.hGetAll(K.statsV2('2026-10-06'));
      expect([stats.fanout_dropped_entries, stats.fanout_dropped_batches]).toEqual(['1', '1']);
    });

    it.each([
      ['an order that is not a whole number', '{"order":1e999,"stamps":[{"wall":1}]}'],
      ['a resume point without its member', '{"order":9,"stamps":[{"wall":1}],"resume":{"entry":"486|2026-10-09|1|0"}}'],
    ])('drops a batch with %s instead of blocking the batches after it', async (_, meta) => {
      const kv = await make();
      await lock(kv);
      const a = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486] }) });
      await kv.script({ name: 'order', lua: "#!lua\nredis.call('SET', KEYS[1], '5') return 'ok'" }, [K.devOrder], []);
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'bad', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'good', ops: [], batch: { id: 'b2', entries: ['486|2026-10-11|1|0'], stamps: [stamp] } });
      await kv.set(K.devFanoutStamps('b1'), meta);
      for (let i = 0; i < 2; i++) await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toEqual({ done: true });
      expect((await job(kv, a.id)).d).toEqual([[486, '2026-10-11', 1, 0]]);
    });

    it('keeps at most 5 pending batches: a sixth is dropped and counted, the email write still goes', async () => {
      const kv = await make();
      await lock(kv);
      for (let i = 0; i < 6; i++) {
        await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [{ op: 'set', key: `pp:test:${i}`, value: '1' }], batch: { id: `b${i}`, entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      }
      expect(await kv.get('pp:test:5')).toBe('1');
      expect(await kv.get(K.devFanoutStamps('b5'))).toBeNull();
      expect((await kv.hGetAll(K.statsV2('2026-10-06'))).fanout_dropped_batches).toBe('1');
    });

    it('turns a batch into one merged job per alert activated before it, whose offices and group match', async () => {
      const kv = await make();
      await lock(kv);
      const early = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486, 693], applicants: 2 }) });
      await kv.script({ name: 'order', lua: "#!lua\nredis.call('SET', KEYS[1], '1') return 'ok'" }, [K.devOrder], []);
      const otherGroup = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486], applicants: 1 }) });
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|2|0', '693|2026-10-10|2|0', '486|2026-10-11|1|0'], stamps: [stamp] } });
      const late = await seedAlert(kv, { now: T0, order: 9, choices: choices({ siteIds: [486], applicants: 2 }) });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toMatchObject({ batch: 'b1', entries: 3 });
      expect(await job(kv, early.id)).toEqual({ i: early.id, n: (await kv.hGetAll(K.devAlert(early.id))).inc, s: [stamp], d: [[486, '2026-10-09', 2, 0], [693, '2026-10-10', 2, 0]] });
      expect((await job(kv, otherGroup.id)).d).toEqual([[486, '2026-10-11', 1, 0]]);
      expect(await job(kv, late.id)).toBeNull();
      expect(await kv.get(K.devFanoutStamps('b1'))).toBeNull(); // done: removed with its list
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toEqual({ done: true });
    });

    it('resumes a batch chunk by chunk, never merging a date twice', async () => {
      const kv = await make();
      await lock(kv);
      const a = await seedAlert(kv, { now: T0, order: 0 });
      const entries = Array.from({ length: 5 }, (_, i) => `486|2026-10-1${i}|1|0`);
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries, stamps: [stamp] } });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 2, maxWork: 100 })).toMatchObject({ entries: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 2, maxWork: 100 })).toMatchObject({ entries: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 2, maxWork: 100 })).toMatchObject({ entries: 1 });
      expect((await job(kv, a.id)).d).toHaveLength(5);
    });

    it('stops a chunk at exactly maxWork recipients, inside an entry, and resumes after the last one handled', async () => {
      const kv = await make();
      await lock(kv);
      const alerts = [];
      for (let i = 0; i < 5; i++) alerts.push(await seedAlert(kv, { now: T0, order: 0 }));
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'm1', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 2 })).toMatchObject({ entries: 0, work: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 2 })).toMatchObject({ entries: 0, work: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 2 })).toMatchObject({ entries: 1, work: 1 });
      for (const a of alerts) expect((await job(kv, a.id)).d).toEqual([[486, '2026-10-09', 1, 0]]);
    });

    it('bounds a job to 30 dates, dropping the oldest and counting them', async () => {
      const kv = await make();
      await lock(kv);
      const a = await seedAlert(kv, { now: T0, order: 0 });
      const stamps = Array.from({ length: 35 }, (_, i) => ({ wall: T0 + i }));
      const entries = stamps.map((_, i) => `486|2026-11-${String(i + 1).padStart(2, '0')}|1|${i}`);
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries, stamps } });
      await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 });
      const j = await job(kv, a.id);
      expect(j.d).toHaveLength(30);
      expect(j.d[0][1]).toBe('2026-11-06'); // the 5 oldest went
      expect((await kv.hGetAll(K.statsV2('2026-10-06'))).dates_dropped_overflow).toBe('5');
      expect(JSON.stringify(j).length).toBeLessThanOrEqual(4096);
    });

    it('stops at the lock\'s loss without writing', async () => {
      const kv = await make();
      await lock(kv);
      await seedAlert(kv, { now: T0, order: 0 });
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      await lock(kv, 'r2');
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toEqual({ lost: true });
      expect(await kv.hGetAll(K.devQueue)).toEqual({});
    });

    it('lists the pairs with held work, by their oldest announcement', async () => {
      const kv = await make();
      const a = await seedAlert(kv, { now: T0, choices: choices({ applicants: 3 }) });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: 'x', s: [{ wall: T0 + 5 }, { wall: T0 }], d: [[486, '2026-10-09', 3, 0], [486, '2026-10-10', 3, 1]] }));
      expect(await heldPairs(kv)).toEqual([[486, 3, T0]]);
    });
  });
}
