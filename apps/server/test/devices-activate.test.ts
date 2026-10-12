import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { endpointHmac } from '../src/push/endpoint.ts';
import { admit, type AdmitInput, change, markGone, type Prepared, readMine, ready, renew, turnOff } from '../src/devices/scripts-api.ts';
import { ALERT_MS, ALERT_UNITS, credentialHash, digest, fingerprint, pushService, sealSetup, sealSubscription, SETUP_MS } from '../src/devices/store.ts';
import { choices, credential, opId, seedAlert, subscription } from './device-fixtures.ts';
import { keys } from './helpers.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const NH = 'h'.repeat(43);
type Kv = Parameters<typeof admit>[0];

function prepared(sub: ReturnType<typeof subscription>, c = choices()): Prepared {
  return { sub: sealSubscription(keys, sub), ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc: pushService(sub.endpoint), offices: c.siteIds.join(','), group: String(c.applicants), pace: c.pace };
}

async function start(kv: Kv, o: { cred?: string; seq?: number; sub?: ReturnType<typeof subscription>; kind?: 'setup' | 'rotate'; cap?: AdmitInput['cap']; now?: number; alertLimit?: number; tok?: string } = {}) {
  const cred = o.cred ?? credential();
  const sub = o.sub ?? subscription();
  const op = opId();
  const now = o.now ?? T0;
  const c = choices();
  const r = await admit(kv, {
    now, cred: credentialHash(cred), op, seq: o.seq ?? 1, kind: o.kind ?? 'setup', cap: o.cap ?? false, digest: digest(o.kind ?? 'setup', sub, c, o.cap || null),
    ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc: pushService(sub.endpoint), sealed: sealSetup(keys, { subscription: sub, choices: c, nonce: 'n'.repeat(43) }),
    nh: NH, tok: o.tok ?? '', exp: now + SETUP_MS, stored: [], alertLimit: o.alertLimit ?? 10, recordLimit: 1000,
  });
  return { cred, hash: credentialHash(cred), op, sub, r };
}

const ack = (kv: Kv, s: { hash: string; op: string; sub: ReturnType<typeof subscription> }, o: { now?: number; nh?: string; ownerMode?: boolean; ownerTok?: string; alertLimit?: number; prep?: Prepared | false } = {}) =>
  ready(kv, { now: o.now ?? T0 + 1000, cred: s.hash, op: s.op, nh: o.nh ?? NH, prep: o.prep ?? prepared(s.sub), newId: opId(), newInc: opId(), ownerMode: o.ownerMode ?? false, ownerTok: o.ownerTok ?? '', alertLimit: o.alertLimit ?? 10 });

for (const [name, make] of valkeyTargets()) {
  describe(`the ready check on ${name}`, () => {
    it('activates a first setup: a new alert, its indexes, an order, 180 days; the reservation becomes the alert', async () => {
      const kv = await make();
      const s = await start(kv);
      const r = await ack(kv, s);
      expect(r.result).toBe('active');
      const id = r.activation!.alertId;
      expect(r.activation).toMatchObject({ generation: 1, revision: 1 });
      const a = await kv.hGetAll(K.devAlert(id));
      expect(a).toMatchObject({ offices: '486', group: '1', pace: 'asap', cred: s.hash, op: s.op, gen: '1', rev: '1', fp: fingerprint(s.sub), end: String(T0 + 1000 + ALERT_MS), order: '1' });
      expect(await kv.get(K.devCred(s.hash))).toBe(id);
      expect(await kv.get(K.devEndpoint(endpointHmac(keys.index, s.sub.endpoint)))).toBe(id);
      expect(await kv.sMembers(K.devSite(486))).toEqual([`${id}:1`]);
      expect(await kv.hGetAll(K.devRecords)).toEqual({ units: String(ALERT_UNITS + 1), alerts: '1' });
      const op = await kv.hGetAll(K.devOp(s.hash));
      expect(op).toMatchObject({ result: 'active', rsv: '' });
      expect(op).not.toHaveProperty('sealed');
      expect(op).not.toHaveProperty('nh');
    });

    it('answers a recorded result again for free, an unknown op as unknown, a wrong nonce as invalid', async () => {
      const kv = await make();
      const s = await start(kv);
      expect((await ack(kv, s, { nh: 'x'.repeat(43) })).result).toBe('invalid');
      expect((await ack(kv, s)).result).toBe('active');
      for (let i = 0; i < 20; i++) expect((await ack(kv, s)).result).toBe('active');
      expect((await ack(kv, { ...s, op: opId() })).result).toBe('unknown');
    });

    it('counts at most 10 acknowledgements per operation', async () => {
      const kv = await make();
      const s = await start(kv);
      for (let i = 0; i < 10; i++) expect((await ack(kv, s, { nh: 'x'.repeat(43) })).result).toBe('invalid');
      expect((await ack(kv, s)).result).toBe('limited');
    });

    it('fails having written nothing, not even an acknowledgement, when the new alert\'s key is taken or the expiry damaged', async () => {
      const kv = await make();
      const s = await start(kv);
      const newId = opId();
      await kv.write([{ op: 'set', key: K.devAlert(newId), value: 'taken' }]);
      const before = await kv.hGetAll(K.devRecords);
      await expect(ready(kv, { now: T0 + 1000, cred: s.hash, op: s.op, nh: NH, prep: prepared(s.sub), newId, newInc: opId(), ownerMode: false, ownerTok: '', alertLimit: 10 })).rejects.toThrow();
      expect(await kv.hGetAll(K.devOp(s.hash))).toMatchObject({ acks: '0', result: '' });
      expect(await kv.hGetAll(K.devRecords)).toEqual(before);
      const t = await start(kv);
      await kv.write([{ op: 'hSet', key: K.devOp(t.hash), fields: { exp: '' } }]);
      await expect(ack(kv, t)).rejects.toThrow(/not an integer/);
      expect(await kv.hGetAll(K.devOp(t.hash))).toMatchObject({ acks: '0', result: '' });
    });

    it('ends an expired setup as expired and releases its reservation', async () => {
      const kv = await make();
      const s = await start(kv);
      expect((await ack(kv, s, { now: T0 + SETUP_MS })).result).toBe('expired');
      expect(await kv.hGetAll(K.devRecords)).toEqual({ units: '1', alerts: '0' });
    });

    it('lets proof of an endpoint win: the other alert is deleted, without an end record, and charged as garbage', async () => {
      const kv = await make();
      const other = await seedAlert(kv, { now: T0 });
      const s = await start(kv, { sub: other.sub });
      const r = await ack(kv, s);
      expect(r.result).toBe('active');
      expect(await kv.hGetAll(K.devAlert(other.id))).toEqual({});
      expect(await kv.get(K.devCred(other.hash))).toBeNull();
      expect(await kv.hGetAll(K.devEnded(other.hash))).toEqual({});
      expect(await kv.hGetAll(K.devGarbage)).toEqual({ [other.id]: String(ALERT_UNITS) });
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ alerts: '1', repl: '0' });
    });

    it('needs a free alert slot for a replacement whose target ended meanwhile, else full', async () => {
      const kv = await make();
      const other = await seedAlert(kv, { now: T0, end: T0 + 500 });
      await seedAlert(kv, { now: T0 }); // the one slot left is taken
      const s = await start(kv, { sub: other.sub, alertLimit: 10 });
      expect((await ack(kv, s, { alertLimit: 1 })).result).toBe('full');
      expect(await kv.hGetAll(K.devEnded(other.hash))).toMatchObject({ reason: 'ended' }); // ended in passing
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ alerts: '1', repl: '0' });
    });

    it('answers changed when what the credential owns no longer matches', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const s = await start(kv, { cred: mine.cred, seq: 2, cap: { incarnation: inc, generation: 1, revision: 1 } });
      await turnOff(kv, { now: T0, cred: mine.hash });
      expect((await ack(kv, { ...s, hash: mine.hash })).result).toBe('unknown'); // turned off: the operation went too
      const t = await start(kv, { cred: mine.cred, seq: 3 });
      await seedAlert(kv, { now: T0, cred: mine.cred });
      expect((await ack(kv, t)).result).toBe('changed');
    });

    it('re-setup with a captured alert replaces choices (revision + 1) and keeps end, order and generation for the same subscription', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 - 1000, rev: 4, order: 7 });
      const before = await kv.hGetAll(K.devAlert(mine.id));
      const s = await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: before.inc!, generation: 1, revision: 4 } });
      const r = await ack(kv, s, { prep: prepared(mine.sub, choices({ siteIds: [693], applicants: 3, pace: 'hourly' })) });
      expect(r).toMatchObject({ result: 'active', activation: { alertId: mine.id, incarnation: before.inc, generation: 1, revision: 5 } });
      const after = await kv.hGetAll(K.devAlert(mine.id));
      expect(after).toMatchObject({ offices: '693', group: '3', pace: 'hourly', end: before.end, order: '7' });
      expect(await kv.sMembers(K.devSite(486))).toEqual([]);
      expect(await kv.sMembers(K.devSite(693))).toEqual([`${mine.id}:3`]);
    });

    it('rotates to a new subscription: generation + 1, endpoint index moved, choices as they are now', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const fresh = subscription();
      const s = await start(kv, { cred: mine.cred, seq: 2, sub: fresh, kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { offices: '693' } }]); // a change meanwhile (simplified)
      const prep = prepared(fresh);
      delete prep.offices;
      delete prep.group;
      delete prep.pace;
      const r = await ack(kv, s, { prep });
      expect(r.activation).toMatchObject({ alertId: mine.id, generation: 2 });
      expect(await kv.hGetAll(K.devAlert(mine.id))).toMatchObject({ gen: '2', fp: fingerprint(fresh), offices: '693' });
      expect(await kv.get(K.devEndpoint(mine.ep))).toBeNull();
      expect(await kv.get(K.devEndpoint(endpointHmac(keys.index, fresh.endpoint)))).toBe(mine.id);
    });

    it('in owner mode, refuses a new alert whose owner token no longer matches; maintenance needs none', async () => {
      const kv = await make();
      const s = await start(kv, { tok: 'old' });
      expect((await ack(kv, s, { ownerMode: true, ownerTok: 'new' })).result).toBe('owner-only');
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const m = await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: inc, generation: 1, revision: 1 } });
      expect((await ack(kv, m, { ownerMode: true, ownerTok: 'new' })).result).toBe('active');
    });

    it('answers expired for a rotation whose alert ended meanwhile, and ends the alert', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, end: T0 + 500 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const s = await start(kv, { cred: mine.cred, seq: 2, sub: subscription(), kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      expect((await ack(kv, s)).result).toBe('expired');
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'ended' });
    });
  });

  describe(`gone, change, renewal, read and turn off on ${name}`, () => {
    it('deletes an alert reported gone for its current generation, leaving the fingerprint; an older generation deletes nothing', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, gen: 2 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      expect(await markGone(kv, { now: T0, id: mine.id, inc, gen: 1 })).toEqual({ gone: 'older' });
      expect(await markGone(kv, { now: T0, id: mine.id, inc, gen: 2 })).toEqual({ gone: 'deleted' });
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'gone', fp: mine.fp });
    });

    it('keeps an alert whose old subscription is gone while a rotation is pending, and deletes it if the rotation fails', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: subscription(), kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      expect(await markGone(kv, { now: T0, id: mine.id, inc, gen: 1 })).toEqual({ gone: 'kept' });
      expect((await kv.hGetAll(K.devAlert(mine.id))).gone).toBe('1');
      expect((await readMine(kv, { now: T0 + SETUP_MS, cred: mine.hash })).a).toBe(false); // the rotation expired: deleted
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'gone' });
    });

    it('applies a change at once when incarnation and revision are current, else answers changed', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, rev: 2 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const base = { now: T0, cred: mine.hash, digest: 'd', inc, offices: '693', group: '2', pace: 'hourly', recordLimit: 100 };
      const op = opId();
      expect(await change(kv, { ...base, op, seq: 2, baseRev: 2 })).toEqual({ result: 'active', revision: 3 });
      expect(await change(kv, { ...base, op, seq: 2, baseRev: 2 })).toEqual({ result: 'active', revision: 3 }); // a repeat
      expect(await change(kv, { ...base, op: opId(), seq: 3, baseRev: 2 })).toEqual({ result: 'changed' });
      expect(await kv.sMembers(K.devSite(693))).toEqual([`${mine.id}:2`]);
    });

    it('keeps a refused change\'s sequence number on the alert, so it outlives the result', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const base = { now: T0, cred: mine.hash, digest: 'd', inc, offices: '693', group: '2', pace: 'hourly', recordLimit: 100 };
      expect(await change(kv, { ...base, op: opId(), seq: 100, baseRev: 7 })).toEqual({ result: 'changed' });
      expect((await kv.hGetAll(K.devAlert(mine.id))).seq).toBe('100');
      // A day later the result is gone; a delayed request with a lower number is still refused.
      expect(await change(kv, { ...base, now: T0 + 25 * 3600_000, op: opId(), seq: 2, baseRev: 1 })).toEqual({ result: 'invalid' });
    });

    it('never recreates part of an alert that finishing an expired rotation deleted', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: subscription(), kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }]);
      const r = await change(kv, { now: T0 + SETUP_MS + 1, cred: mine.hash, op: opId(), seq: 3, digest: 'd', inc, baseRev: 1, offices: '693', group: '1', pace: 'asap', recordLimit: 100 });
      expect(r).toEqual({ result: 'changed' });
      expect(await kv.hGetAll(K.devAlert(mine.id))).toEqual({});
      expect(await kv.sMembers(K.devSite(693))).toEqual([]);
    });

    it('waits behind a setup in progress', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: inc, generation: 1, revision: 1 } });
      expect(await change(kv, { now: T0, cred: mine.hash, op: opId(), seq: 3, digest: 'd', inc, baseRev: 1, offices: '693', group: '1', pace: 'asap', recordLimit: 100 })).toEqual({ result: 'busy' });
    });

    it('renews to 180 days from now, never earlier than the current end', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, end: T0 + 200 * 86_400_000 });
      expect(await renew(kv, { now: T0, cred: mine.hash })).toEqual({ state: 'active', endsAt: T0 + 200 * 86_400_000 });
      expect(await renew(kv, { now: T0 + 30 * 86_400_000, cred: mine.hash })).toEqual({ state: 'active', endsAt: T0 + 210 * 86_400_000 });
      expect(await renew(kv, { now: T0, cred: credentialHash(credential()) })).toEqual({ state: 'none' });
    });

    it('reads an ended alert as ended, ending it in the same step', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, end: T0 + 10 });
      const r = await readMine(kv, { now: T0 + 10, cred: mine.hash });
      expect(r.a).toBe(false);
      expect(r.e).toMatchObject({ reason: 'ended', at: String(T0 + 10) });
    });

    it('turns off: alert, indexes, operation (with its reservation) and end record go; delivery units stay as garbage', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: inc, generation: 1, revision: 1 } });
      expect(await turnOff(kv, { now: T0, cred: mine.hash })).toEqual({ deleted: true });
      const exists = (key: string) => kv.script({ name: 'exists', lua: "#!lua\nreturn tostring(redis.call('EXISTS', KEYS[1]))" }, [key], []);
      for (const key of [K.devAlert(mine.id), K.devCred(mine.hash), K.devOp(mine.hash), K.devEnded(mine.hash)]) expect([key, await exists(key)]).toEqual([key, '0']);
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ units: String(ALERT_UNITS), alerts: '0' });
      expect(await turnOff(kv, { now: T0, cred: mine.hash })).toEqual({ deleted: true });
    });
  });
}
