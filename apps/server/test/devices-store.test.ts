import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { endpointHmac } from '../src/push/endpoint.ts';
import { admit, type AdmitInput, dispatchBegin, dispatchEnd, reclaim } from '../src/devices/scripts-api.ts';
import { ALERT_UNITS, credentialHash, digest, fingerprint, opView, pushService, sealSetup, SETUP_MS } from '../src/devices/store.ts';
import { choices, credential, opId, seedAlert, subscription } from './device-fixtures.ts';
import { keys, MemoryKv } from './helpers.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const limits = { alertLimit: 3, recordLimit: 100 };

function setup(cred: string, o: Partial<AdmitInput> & { sub?: ReturnType<typeof subscription>; cap?: AdmitInput['cap'] } = {}): AdmitInput {
  const sub = o.sub ?? subscription();
  const c = choices();
  return {
    now: T0, cred: credentialHash(cred), op: opId(), seq: 1, kind: 'setup', cap: false,
    digest: digest('setup', sub, c, o.cap || null), ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc: pushService(sub.endpoint),
    sealed: sealSetup(keys, { subscription: sub, choices: c, nonce: 'n'.repeat(43) }), nh: 'h'.repeat(43), tok: '', exp: T0 + SETUP_MS,
    stored: [], ...limits, ...o,
  };
}
const records = async (kv: Parameters<typeof admit>[0]) => kv.hGetAll(K.devRecords);

for (const [name, make] of valkeyTargets()) {
  describe(`admission on ${name}`, () => {
    it('stores a first setup with a reservation and one operation unit', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      const r = await admit(kv, a);
      expect(r.outcome).toBe('pending');
      expect(r.o).toMatchObject({ op: a.op, seq: '1', kind: 'setup', rsv: 'alert', dsp: 'unsent', result: '', exp: String(T0 + SETUP_MS) });
      expect(await records(kv)).toEqual({ units: String(ALERT_UNITS + 1), alerts: '1' });
      expect(opView(r.o!, T0)).toMatchObject({ op: a.op, kind: 'setup', dispatch: 'unsent', result: null, expiresAt: new Date(T0 + SETUP_MS).toISOString() });
    });

    it('answers a repeat with the same request by its state, and a different one as invalid, changing nothing', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const before = await records(kv);
      expect((await admit(kv, a)).outcome).toBe('repeat');
      expect((await admit(kv, { ...a, digest: 'other' })).outcome).toBe('invalid');
      expect(await records(kv)).toEqual(before);
    });

    it('refuses a sequence number not higher than the highest used, and another operation while one runs', async () => {
      const kv = await make();
      const c = credential();
      await admit(kv, setup(c, { seq: 5 }));
      expect((await admit(kv, setup(c, { seq: 5 }))).outcome).toBe('invalid');
      expect((await admit(kv, setup(c, { seq: 6 }))).outcome).toBe('busy');
    });

    it('ends an expired operation as expired, releasing its reservation, and admits the next', async () => {
      const kv = await make();
      const c = credential();
      await admit(kv, setup(c, { seq: 1 }));
      const next = await admit(kv, setup(c, { seq: 2, now: T0 + SETUP_MS + 1, exp: T0 + 2 * SETUP_MS }));
      expect(next.outcome).toBe('pending');
      expect(await records(kv)).toEqual({ units: String(ALERT_UNITS + 1), alerts: '1' });
    });

    it('refuses a new alert at the ceiling, and anything past the record limit, writing nothing', async () => {
      const kv = await make();
      for (let i = 0; i < 3; i++) expect((await admit(kv, setup(credential()))).outcome).toBe('pending');
      const before = await records(kv);
      expect((await admit(kv, setup(credential()))).outcome).toBe('full');
      expect((await admit(kv, setup(credential(), { alertLimit: 10, recordLimit: Number(before.units) + 5 }))).outcome).toBe('full');
      expect(await records(kv)).toEqual(before);
    });

    it('counts a stored new setup against its IP and the global pool, and refuses past them without writing', async () => {
      const kv = await make();
      const item = { cur: 'pp:rate:t:1:ip', prev: 'pp:rate:t:0:ip', overlap: 1, max: 1, ttl: 3_600_000, bucket: 'dev-stored-ip' };
      expect((await admit(kv, setup(credential(), { stored: [item] }))).outcome).toBe('pending');
      const before = await records(kv);
      expect((await admit(kv, setup(credential(), { stored: [item] }))).outcome).toBe('limited');
      expect(await records(kv)).toEqual(before);
    });

    it('checks the stored counters before ending an expired operation: a damaged one fails the step having written nothing', async () => {
      const kv = await make();
      const c = credential();
      const first = setup(c);
      await admit(kv, first);
      const item = { cur: 'pp:rate:t:1:ip', prev: 'pp:rate:t:0:ip', overlap: 1, max: 5, ttl: 3_600_000, bucket: 'dev-stored-ip' };
      await kv.write([{ op: 'set', key: item.cur, value: '1.5' }]);
      const before = await records(kv);
      await expect(admit(kv, setup(c, { seq: 2, now: T0 + SETUP_MS + 1, exp: T0 + 2 * SETUP_MS, stored: [item] }))).rejects.toThrow(/not a counter/);
      expect(await kv.hGetAll(K.devOp(credentialHash(c)))).toMatchObject({ op: first.op, result: '' });
      expect(await records(kv)).toEqual(before);
    });

    it('takes the highest sequence number the contracts allow, and still answers, expires and reclaims it', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c, { seq: Number.MAX_SAFE_INTEGER });
      expect((await admit(kv, a)).outcome).toBe('pending');
      expect((await admit(kv, a)).outcome).toBe('repeat');
      expect(await reclaim(kv, T0 + SETUP_MS)).toEqual({ expired: 1, ended: 0, deleted: 0 });
      expect(await records(kv)).toEqual({ units: '1', alerts: '0' });
    });

    it('admits a setup for an endpoint another alert has as one replacement candidate, within 10% of the ceiling', async () => {
      const kv = await make();
      const owner = await seedAlert(kv, { now: T0 });
      const r = await admit(kv, setup(credential(), { sub: owner.sub, alertLimit: 10 }));
      expect(r.outcome).toBe('pending');
      expect(r.o).toMatchObject({ rsv: 'repl', other: owner.id });
      expect((await kv.hGetAll(K.devAlert(owner.id))).cand).toBeDefined();
      expect((await admit(kv, setup(credential(), { sub: owner.sub, alertLimit: 10 }))).outcome).toBe('busy');
      expect((await records(kv)).repl).toBe('1');
    });

    it('needs the captured alert for a re-setup, and incarnation and generation for a rotation', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, gen: 2, rev: 3 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      expect((await admit(kv, setup(mine.cred, { seq: 2, cap: { incarnation: inc, generation: 2, revision: 2 } }))).outcome).toBe('changed');
      expect((await admit(kv, setup(mine.cred, { seq: 2 }))).outcome).toBe('changed'); // a first setup needs no alert
      expect((await admit(kv, setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 2 } }))).outcome).toBe('pending');
      expect(await records(kv)).toMatchObject({ alerts: '1' }); // no reservation for maintenance
    });

    it('ends the credential\'s own ended alert first, leaving an end record, and then admits a first setup', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      expect((await admit(kv, setup(mine.cred, { seq: 2 }))).outcome).toBe('pending');
      expect(await kv.get(K.devAlert(mine.id))).toBeNull();
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'ended', at: String(T0) });
      expect(await kv.hGetAll(K.devGarbage)).toEqual({ [mine.id]: String(ALERT_UNITS - 1) });
    });

    it('after finishing an expired rotation whose old subscription was gone, never writes to the deleted alert', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await admit(kv, setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } }));
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }]);
      const r = await admit(kv, setup(mine.cred, { seq: 3, now: T0 + SETUP_MS + 1, exp: T0 + 2 * SETUP_MS }));
      expect(r.outcome).toBe('pending'); // a first setup: the alert went with its rotation
      expect(await kv.hGetAll(K.devAlert(mine.id))).toEqual({});
    });

    it('fails without writing anything when an alert it would delete has a damaged index or field', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      // The ended alert's endpoint index is damaged (a set, not a string): deleting it would fail half-way.
      await kv.write([{ op: 'del', key: K.devEndpoint(mine.ep) }, { op: 'sAdd', key: K.devEndpoint(mine.ep), members: ['wrong type'] }]);
      const records = await kv.hGetAll(K.devRecords);
      await expect(admit(kv, setup(mine.cred, { seq: 2 }))).rejects.toThrow(/WRONGTYPE/);
      expect(await kv.hGetAll(K.devAlert(mine.id))).not.toEqual({});
      expect(await kv.hGetAll(K.devRecords)).toEqual(records);
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toEqual({});
    });

    it('refuses a new setup while push is paused or its push service backs off, checked in the same step', async () => {
      const kv = await make();
      await kv.set(K.pushPaused, '1');
      expect((await admit(kv, setup(credential()))).outcome).toBe('unavailable');
      await kv.write([{ op: 'del', key: K.pushPaused }]);
      await kv.set(K.pushBackoff('fcm'), String(T0 + 60_000));
      expect((await admit(kv, setup(credential()))).outcome).toBe('unavailable');
      expect(await kv.hGetAll(K.devRecords)).toEqual({});
    });

    it('fails without writing anything when a key has the wrong type', async () => {
      const kv = await make();
      await kv.set(K.devRecords, 'oops');
      await expect(admit(kv, setup(credential()))).rejects.toThrow(/WRONGTYPE/);
      expect(await kv.get(K.devRecords)).toBe('oops');
    });
  });

  describe(`setup dispatch on ${name}`, () => {
    const gate = (cred: string, op: string, o: Partial<Parameters<typeof dispatchBegin>[1]> = {}) => ({
      now: T0, cred: credentialHash(cred), op, did: opId(), svc: 'fcm', ep: 'e', modeOk: true, epItems: [], maintItems: [], ...o,
    });

    it('sends once: the first begin moves unsent to sending, a second begin does not', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      expect((await dispatchBegin(kv, gate(c, a.op))).go).toBe(true);
      expect((await dispatchBegin(kv, gate(c, a.op))).go).toBe(false);
    });

    it.each([
      ['the mode', { modeOk: false }, 'mode'],
      ['the emergency stop', {}, 'paused'],
      ['a push service backoff', {}, 'backoff'],
    ])('holds the push for %s, saying why and when to try again', async (_, o, why) => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      if (why === 'paused') await kv.set(K.pushPaused, '1');
      if (why === 'backoff') await kv.set(K.pushBackoff('fcm'), String(T0 + 60_000));
      const r = await dispatchBegin(kv, gate(c, a.op, o));
      expect(r.go).toBe(false);
      expect(r.o).toMatchObject({ dsp: 'unsent', why, retry: String(why === 'backoff' ? T0 + 60_000 : T0 + 30_000) });
    });

    it('limits setup pushes to an endpoint whose alert the credential does not own', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const ep = { cur: 'pp:rate:dev-push-ep:1:e', prev: 'pp:rate:dev-push-ep:0:e', overlap: 1, max: 0, ttl: 3_600_000, bucket: 'dev-push-ep' };
      expect((await dispatchBegin(kv, gate(c, a.op, { epItems: [ep] }))).o).toMatchObject({ why: 'limited' });
    });

    it('limits a rotation\'s or re-setup\'s pushes to an endpoint another alert owns by that endpoint too, not only the maintenance pool', async () => {
      const kv = await make();
      const victim = await seedAlert(kv, { now: T0 });
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const a = setup(mine.cred, { seq: 2, kind: 'rotate', sub: victim.sub, cap: { incarnation: inc, generation: 1 } });
      expect((await admit(kv, a)).outcome).toBe('pending');
      const ep = { cur: 'pp:rate:dev-push-ep:1:e', prev: 'pp:rate:dev-push-ep:0:e', overlap: 1, max: 0, ttl: 3_600_000, bucket: 'dev-push-ep' };
      expect((await dispatchBegin(kv, gate(mine.cred, a.op, { ep: victim.ep, epItems: [ep] }))).o).toMatchObject({ dsp: 'unsent', why: 'limited' });
      // Its own endpoint is the maintenance pool's alone.
      const own = setup(mine.cred, { seq: 3, kind: 'rotate', sub: mine.sub, cap: { incarnation: inc, generation: 1 }, now: T0 + SETUP_MS + 1, exp: T0 + 2 * SETUP_MS });
      expect((await admit(kv, own)).outcome).toBe('pending');
      expect((await dispatchBegin(kv, gate(mine.cred, own.op, { now: T0 + SETUP_MS + 1, ep: mine.ep, epItems: [ep] }))).go).toBe(true);
    });

    it('ends an expired operation at the gate instead of sending', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const r = await dispatchBegin(kv, gate(c, a.op, { now: T0 + SETUP_MS }));
      expect(r.go).toBe(false);
      expect(r.o).toMatchObject({ result: 'expired' });
      expect(await records(kv)).toEqual({ units: '1', alerts: '0' });
    });

    it.each([
      ['accepted', 'accepted', ''],
      ['uncertain', 'uncertain', ''],
      ['retryable', 'retryable', ''],
      ['failed', 'failed', 'failed'],
      ['gone', 'failed', 'gone'],
    ] as const)('settles a %s dispatch by its id only', async (outcome, dsp, result) => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const g = gate(c, a.op);
      await dispatchBegin(kv, g);
      expect((await dispatchEnd(kv, { now: T0, cred: g.cred, op: a.op, did: 'someone-else', svc: 'fcm', outcome, backoffUntil: null })).ok).toBe(false);
      expect((await dispatchEnd(kv, { now: T0, cred: g.cred, op: a.op, did: g.did, svc: 'fcm', outcome, backoffUntil: null })).ok).toBe(true);
      // Spec step 4: bug and gone both leave the dispatch state failed.
      expect(await kv.hGetAll(K.devOp(g.cred))).toMatchObject({ dsp, result });
      if (result) expect(await records(kv)).toEqual({ units: '1', alerts: '0' });
    });

    it('fails without writing anything when a rotation it would finish has an alert with a damaged index', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const rot = setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await admit(kv, rot);
      const g = gate(mine.cred, rot.op);
      await dispatchBegin(kv, g);
      // The old subscription was reported gone, and the alert's endpoint index is damaged: a failed rotation would delete it.
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }, { op: 'del', key: K.devEndpoint(mine.ep) }, { op: 'sAdd', key: K.devEndpoint(mine.ep), members: ['wrong type'] }]);
      const before = { alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords), backoff: await kv.get(K.pushBackoff('fcm')) };
      await expect(dispatchEnd(kv, { now: T0, cred: g.cred, op: rot.op, did: g.did, svc: 'fcm', outcome: 'failed', backoffUntil: T0 + 60_000 })).rejects.toThrow(/WRONGTYPE/);
      await expect(dispatchBegin(kv, gate(mine.cred, rot.op, { now: T0 + SETUP_MS }))).rejects.toThrow(/WRONGTYPE/);
      expect({ alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords), backoff: await kv.get(K.pushBackoff('fcm')) }).toEqual(before);
    });

    it.each(['1.0', '1e0', '01', '9007199254740993'])('fails without writing anything when a record counter reads %s', async (bad) => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const rot = setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await admit(kv, rot);
      const g = gate(mine.cred, rot.op);
      await dispatchBegin(kv, g);
      // A failed rotation of an alert whose old subscription was gone deletes it, then counts: the count is checked first.
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }, { op: 'hSet', key: K.devRecords, fields: { alerts: bad } }]);
      const before = { alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords) };
      await expect(dispatchEnd(kv, { now: T0, cred: g.cred, op: rot.op, did: g.did, svc: 'fcm', outcome: 'failed', backoffUntil: null })).rejects.toThrow(/not an integer/);
      expect({ alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords) }).toEqual(before);
    });

    it('sets the shared backoff for a throttled dispatch, never earlier than one already set', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const g = gate(c, a.op);
      await dispatchBegin(kv, g);
      await kv.set(K.pushBackoff('fcm'), String(T0 + 900_000));
      await dispatchEnd(kv, { now: T0, cred: g.cred, op: a.op, did: g.did, svc: 'fcm', outcome: 'retryable', backoffUntil: T0 + 60_000 });
      expect(await kv.get(K.pushBackoff('fcm'))).toBe(String(T0 + 900_000));
      expect(await kv.hGetAll(K.devOp(g.cred))).toMatchObject({ dsp: 'retryable', retry: String(T0 + 900_000) });
    });
  });

  describe(`reclaim on ${name}`, () => {
    it('ends expired operations and ended alerts, and deletes overdue results and end records, at most the batch', async () => {
      const kv = await make();
      const c = credential();
      await admit(kv, setup(c));
      const old = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      expect(await reclaim(kv, T0 + SETUP_MS)).toEqual({ expired: 1, ended: 1, deleted: 0 });
      expect(await reclaim(kv, T0 + SETUP_MS + 31 * 86_400_000)).toEqual({ expired: 0, ended: 0, deleted: 2 });
      expect(await kv.get(K.devOp(credentialHash(c)))).toBeNull();
      expect(await kv.get(K.devEnded(old.hash))).toBeNull();
      // Only the ended alert's garbage is still charged: the checker removes its delivery keys.
      expect(await records(kv)).toEqual({ units: String(ALERT_UNITS - 1), alerts: '0' });
    });

    it('stops, writing nothing, at an alert whose number field reads "-0" (Lua 5.1 prints negative zero as itself)', async () => {
      const kv = await make();
      const old = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      await kv.write([{ op: 'hSet', key: K.devAlert(old.id), fields: { gen: '-0' } }]);
      const before = await records(kv);
      await expect(reclaim(kv, T0)).rejects.toThrow(/not an integer/);
      expect(await kv.hGetAll(K.devAlert(old.id))).toMatchObject({ gen: '-0' });
      expect(await records(kv)).toEqual(before);
    });

    it('stops, writing nothing, at an ended alert missing a field its deletion needs', async () => {
      const kv = await make();
      const old = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      await kv.write([{ op: 'hDel', key: K.devAlert(old.id), fields: ['offices'] }]);
      const before = await records(kv);
      await expect(reclaim(kv, T0)).rejects.toThrow(/alert/);
      expect(await kv.hGetAll(K.devAlert(old.id))).toMatchObject({ inc: expect.any(String) });
      expect(await kv.get(K.devCred(old.hash))).toBe(old.id);
      expect(await records(kv)).toEqual(before);
    });

    it('keeps the end record an expired rotation leaves in the same batch, though the old one was overdue', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      // An end record from the credential's earlier alert, overdue.
      await kv.write([{ op: 'hSet', key: K.devEnded(mine.hash), fields: { reason: 'ended', at: String(T0 - 31 * 86_400_000), fp: '' } }]);
      await kv.script({ name: 'seed-deadline', lua: `#!lua\nredis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) redis.call('HINCRBY', KEYS[2], 'units', 1) return 'ok'` }, [K.devDeadlines, K.devRecords], [String(T0 - 1), `ended|${mine.hash}`]);
      expect((await admit(kv, setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } }))).outcome).toBe('pending');
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }]);
      expect(await reclaim(kv, T0 + SETUP_MS)).toEqual({ expired: 1, ended: 0, deleted: 0 });
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toEqual({ reason: 'gone', at: String(T0 + SETUP_MS), fp: mine.fp });
      // 29 days on, only the operation's result (kept a day) is due: the new end record stays its 30 days.
      expect(await reclaim(kv, T0 + SETUP_MS + 29 * 86_400_000)).toEqual({ expired: 0, ended: 0, deleted: 1 });
      expect(await kv.get(K.devOp(mine.hash))).toBeNull();
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'gone' });
    });

    it('spends no slot of the batch on an alert an expired rotation in it already deleted', async () => {
      const kv = await make();
      const a = await seedAlert(kv, { now: T0, end: T0 + 1000 });
      const b = await seedAlert(kv, { now: T0, end: T0 + 2000 });
      const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
      expect((await admit(kv, setup(a.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } }))).outcome).toBe('pending');
      await kv.write([{ op: 'hSet', key: K.devAlert(a.id), fields: { gone: '1' } }]);
      expect(await reclaim(kv, T0 + SETUP_MS, 2)).toEqual({ expired: 1, ended: 1, deleted: 0 });
      expect(await kv.hGetAll(K.devAlert(b.id))).toEqual({});
    });

    it('checks deadlines that move up into the batch when finishing its operations pushes earlier ones out', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const rot = setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      expect((await admit(kv, rot)).outcome).toBe('pending');
      await kv.write([
        { op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } },
        { op: 'hSet', key: K.devEnded(mine.hash), fields: { reason: 'ended', at: String(T0 - 31 * 86_400_000), fp: '' } },
      ]);
      // A stale result deadline and an overdue end record, both pushed out by the rotation's finish, then a damaged one.
      await kv.script(
        { name: 'seed-deadlines', lua: `#!lua\nredis.call('ZADD', KEYS[1], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6]) redis.call('HINCRBY', KEYS[2], 'units', 1) return 'ok'` },
        [K.devDeadlines, K.devRecords],
        [String(T0 - 3), `op|${mine.hash}`, String(T0 - 2), `ended|${mine.hash}`, String(T0 - 1), 'damaged'],
      );
      const before = await records(kv);
      await expect(reclaim(kv, T0 + SETUP_MS, 2)).rejects.toThrow(/damaged deadline/);
      expect(await kv.hGetAll(K.devAlert(mine.id))).toMatchObject({ inc });
      expect(await kv.hGetAll(K.devOp(mine.hash))).toMatchObject({ op: rot.op, result: '' });
      expect(await records(kv)).toEqual(before);
    });

    it('checks the whole batch before changing anything: one damaged item and nothing in the batch is done', async () => {
      const kv = await make();
      const [c1, c2] = [credential(), credential()];
      await admit(kv, setup(c1));
      await admit(kv, setup(c2));
      await kv.write([{ op: 'hSet', key: K.devOp(credentialHash(c2)), fields: { exp: '1.5' } }]);
      const before = await records(kv);
      await expect(reclaim(kv, T0 + SETUP_MS)).rejects.toThrow(/not an integer/);
      expect(await kv.hGetAll(K.devOp(credentialHash(c1)))).toMatchObject({ result: '' });
      expect(await kv.hGetAll(K.devOp(credentialHash(c2)))).toMatchObject({ result: '' });
      expect(await records(kv)).toEqual(before);
    });
  });
}

describe('the request digest', () => {
  it('does not depend on the order of the captured alert\'s fields', () => {
    const sub = subscription();
    expect(digest('rotate', sub, null, { incarnation: 'i'.repeat(22), generation: 1 })).toBe(digest('rotate', sub, null, { generation: 1, incarnation: 'i'.repeat(22) }));
    expect(digest('setup', sub, choices(), { revision: 2, generation: 1, incarnation: 'i'.repeat(22) })).toBe(digest('setup', sub, choices(), { incarnation: 'i'.repeat(22), generation: 1, revision: 2 }));
    expect(digest('rotate', sub, null, { incarnation: 'i'.repeat(22), generation: 1 })).not.toBe(digest('rotate', sub, null, { incarnation: 'i'.repeat(22), generation: 2 }));
  });
});

describe('units', () => {
  it('match the configuration check (5 per alert, config.ts)', () => {
    expect(ALERT_UNITS).toBe(5);
  });
});

describe('admission and memory', () => {
  it('is refused before it starts when Valkey is out of memory', async () => {
    const kv = new MemoryKv();
    kv.oom = true;
    await expect(admit(kv, setup(credential()))).rejects.toThrow(/OOM/);
    expect(kv.keys()).toEqual([]);
  });

  it('reclaims even when out of memory', async () => {
    const kv = new MemoryKv();
    kv.oom = true;
    expect(await reclaim(kv, T0)).toEqual({ expired: 0, ended: 0, deleted: 0 });
  });
});
