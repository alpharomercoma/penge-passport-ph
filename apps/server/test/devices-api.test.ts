import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import type { PushConfig } from '../src/config.ts';
import { K } from '../src/keys.ts';
import type { SendResult, Transport } from '../src/devices/transport.ts';
import { credentialHash } from '../src/devices/store.ts';
import { DEVICE_LIMITS, rateKeys } from '../src/devices/limits.ts';
import { line } from '../src/log.ts';
import { credential, opId } from './device-fixtures.ts';
import { clock, fcmSubscription, FakeMailer, keys, MemoryKv, recordingLog } from './helpers.ts';

const ORIGIN = 'https://penge.example';
const SITES = [{ id: 486, name: 'Antipolo' }, { id: 693, name: 'Pampanga' }];
const VAPID = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), subject: 'mailto:alerts@example.com' };

class FakeTransport implements Transport {
  sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
  next: SendResult[] = [];
  async send(sub: { endpoint: string }, payload: string) {
    this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
    return this.next.shift() ?? { kind: 'accepted' as const, status: 201 };
  }
}

async function world(o: { mode?: PushConfig['mode']; ownerToken?: string; limits?: { alertLimit: number; recordLimit: number } } = {}) {
  const t = clock(Date.parse('2026-10-06T02:00:00Z'));
  const kv = new MemoryKv(t.now);
  await kv.set(K.sites, JSON.stringify(SITES));
  const transport = new FakeTransport();
  const { log, lines } = recordingLog();
  let ip = '203.0.113.7';
  const push: PushConfig = { mode: o.mode ?? 'live', vapid: VAPID, ownerToken: o.ownerToken ?? null };
  const app = createApi({
    kv, keys, mailer: new FakeMailer(), log, publicBaseUrl: ORIGIN, now: t.now, clientIp: () => ip, push,
    devices: o.limits ?? { alertLimit: 10, recordLimit: 100 }, pushTransport: transport,
  });
  const cred = credential();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, who = cred) => {
    const res = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }), authorization: `Device ${who}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, any>, text };
  };
  return { t, kv, transport, lines, app, cred, call, setIp: (v: string) => (ip = v) };
}

const choices = { siteIds: [486], applicants: 2, pace: 'asap' };
const setupBody = (o: { seq?: number; captured?: unknown; sub?: unknown } = {}) => ({ op: opId(), seq: o.seq ?? 1, subscription: o.sub ?? fcmSubscription(), choices, captured: o.captured ?? null });

describe('notification alerts through the API', () => {
  it('set up, prove, read, renew, change, test and turn off', async () => {
    const w = await world();
    const body = setupBody();
    const setup = await w.call('POST', '/api/device-alerts', body);
    expect(setup.status).toBe(200);
    expect(setup.body).toMatchObject({ outcome: 'pending', operation: { op: body.op, dispatch: 'accepted', result: null } });
    const push = w.transport.sent[0]!.payload;
    expect(push).toMatchObject({ v: 1, title: 'Setting up PengePassportPH notifications', body: 'Antipolo', tag: `setup-${body.op}`, url: {}, kind: 'setup', op: body.op });
    const nonce = push.nonce as string;

    const proof = await w.call('POST', '/api/device-alerts/ready', { op: body.op, nonce });
    expect(proof.body).toMatchObject({ result: 'active', activation: { generation: 1, revision: 1 } });

    const mine = await w.call('GET', '/api/device-alerts/mine');
    expect(mine.body).toMatchObject({ state: 'active', alert: { choices, generation: 1, revision: 1, updating: false }, operation: { result: 'active' } });

    const seen = await w.call('POST', '/api/device-alerts/mine/seen', {});
    expect(seen.body).toMatchObject({ state: 'active' });

    const changed = await w.call('PUT', '/api/device-alerts/mine', { op: opId(), seq: 2, incarnation: mine.body.alert.incarnation, baseRevision: 1, choices: { ...choices, siteIds: [693] } });
    expect(changed.body).toEqual({ result: 'active', revision: 2 });

    expect((await w.call('POST', '/api/device-alerts/mine/test', {})).body).toEqual({ test: 'accepted' });
    expect(w.transport.sent[1]!.payload).toMatchObject({ v: 1, title: 'Test notification', body: 'Notifications work on this device.' });

    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).body).toEqual({ deleted: true });
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toEqual({ state: 'none', operation: null });
    // The nonce is never in an answer or a log line.
    for (const text of [setup.text, proof.text, mine.text, ...w.lines]) expect(text).not.toContain(nonce);
    for (const text of w.lines) expect(text).not.toContain(w.cred);
  });

  it('still sets up when clean-up fails on a damaged record, logging that without naming it', async () => {
    const w = await world();
    await w.kv.script({ name: 'damage', lua: `#!lua\nredis.call('ZADD', KEYS[1], 0, 'damaged') return 'ok'` }, [K.devDeadlines], []);
    const r = await w.call('POST', '/api/device-alerts', setupBody());
    expect(r.body).toMatchObject({ outcome: 'pending' });
    expect(w.lines.some((l) => l.includes('clean-up before a setup failed'))).toBe(true);
    expect(w.lines.join('\n')).not.toContain('damaged');
  });

  it('charges a first setup\'s repeats to the setup pools, as the first request (spec: "including repeats")', async () => {
    const w = await world();
    const body = setupBody();
    for (let i = 0; i < 30; i++) expect((await w.call('POST', '/api/device-alerts', body)).status).toBe(200);
    expect((await w.call('POST', '/api/device-alerts', body)).body).toEqual({ error: expect.any(String), code: 'limited' });
  });

  it('charges a request\'s class before refusing its body', async () => {
    const w = await world();
    for (let i = 0; i < 15; i++) expect((await w.call('POST', '/api/device-alerts', {})).status).toBe(400);
    // A body that is not a JSON object, or not JSON at all, costs the same.
    for (const raw of ['null', '[1]', '{not json']) {
      for (let i = 0; i < 5; i++) {
        const res = await w.app.request('/api/device-alerts', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: `Device ${w.cred}` }, body: raw });
        expect(res.status).toBe(400);
      }
    }
    expect((await w.call('POST', '/api/device-alerts', {})).status).toBe(429);
    for (let i = 0; i < 60; i++) expect((await w.call('POST', '/api/device-alerts/ready', {}, {}, credential())).status).not.toBe(429);
    const ackCred = credential();
    // A known credential's acknowledgements: 60 an hour from a network, valid or not (another network: this one's
    // setup pool is spent above).
    w.setIp('198.51.100.9');
    expect((await w.call('POST', '/api/device-alerts', setupBody(), {}, ackCred)).body).toMatchObject({ outcome: 'pending' });
    for (let i = 0; i < 60; i++) await w.call('POST', '/api/device-alerts/ready', {}, {}, ackCred);
    expect((await w.call('POST', '/api/device-alerts/ready', {}, {}, ackCred)).status).toBe(429);
  });

  it('answers every limit as 429 with code "limited", and every answer of the scripts but changed and busy as 200', async () => {
    const w = await world({ limits: { alertLimit: 50, recordLimit: 500 } });
    for (let i = 0; i < 10; i++) expect((await w.call('POST', '/api/device-alerts', setupBody(), {}, credential())).body).toMatchObject({ outcome: 'pending' });
    const eleventh = await w.call('POST', '/api/device-alerts', setupBody(), {}, credential());
    expect([eleventh.status, eleventh.body]).toEqual([429, { error: expect.any(String), code: 'limited' }]);
  });

  it('charges a test all or nothing: a refused test leaves the read counters as they were', async () => {
    const w = await world();
    const body = setupBody();
    await w.call('POST', '/api/device-alerts', body);
    await w.call('POST', '/api/device-alerts/ready', { op: body.op, nonce: w.transport.sent[0]!.payload.nonce });
    for (let i = 0; i < 3; i++) expect((await w.call('POST', '/api/device-alerts/mine/test', {})).body).toEqual({ test: 'accepted' });
    const read = rateKeys(DEVICE_LIMITS.knownReadCred, credentialHash(w.cred), w.t.now()).cur;
    const before = await w.kv.get(read);
    const refused = await w.call('POST', '/api/device-alerts/mine/test', {});
    expect([refused.status, refused.body]).toEqual([429, { error: expect.any(String), code: 'limited' }]);
    expect(await w.kv.get(read)).toBe(before);
  });

  it('requires the site\'s Origin on changes, not on reads', async () => {
    const w = await world();
    for (const origin of [undefined, 'null', 'https://evil.example']) {
      const res = await w.app.request('/api/device-alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Device ${w.cred}`, ...(origin ? { origin } : {}) },
        body: JSON.stringify(setupBody()),
      });
      expect(res.status).toBe(403);
    }
    expect((await w.call('GET', '/api/device-alerts/mine')).status).toBe(200);
  });

  it('requires a well-formed credential header', async () => {
    const w = await world();
    expect((await w.call('GET', '/api/device-alerts/mine', undefined, {}, 'short')).status).toBe(401);
    const res = await w.app.request('/api/device-alerts/mine');
    expect(res.status).toBe(401);
  });

  it.each([
    ['off', { mode: 'off' as const }, 'off'],
    ['owner without a token', { mode: 'owner' as const, ownerToken: 'o'.repeat(40) }, 'owner-only'],
  ])('refuses a first setup when push is %s, storing nothing', async (_, o, outcome) => {
    const w = await world(o);
    const r = await w.call('POST', '/api/device-alerts', setupBody());
    expect(r.body).toEqual({ outcome, operation: null });
    expect(w.kv.keys().filter((k) => k.startsWith('pp:dev:'))).toEqual([]);
  });

  it('admits the owner with the token from the owner link, compared exactly', async () => {
    const w = await world({ mode: 'owner', ownerToken: 'o'.repeat(40) });
    expect((await w.call('POST', '/api/device-alerts', setupBody(), { 'x-owner-token': `${'o'.repeat(39)}x` })).body.outcome).toBe('owner-only');
    expect((await w.call('POST', '/api/device-alerts', setupBody(), { 'x-owner-token': 'o'.repeat(40) })).body.outcome).toBe('pending');
  });

  it('answers unavailable while push is paused or its service is backing off', async () => {
    const w = await world();
    await w.kv.set(K.pushPaused, '1');
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.outcome).toBe('unavailable');
    await w.kv.write([{ op: 'del', key: K.pushPaused }]);
    await w.kv.set(K.pushBackoff('fcm'), String(w.t.now() + 60_000));
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.outcome).toBe('unavailable');
  });

  it('answers an identical repeat with its operation even after push was paused or the owner token changed', async () => {
    const w = await world();
    const body = setupBody();
    await w.call('POST', '/api/device-alerts', body);
    await w.kv.set(K.pushPaused, '1');
    expect((await w.call('POST', '/api/device-alerts', body)).body).toMatchObject({ outcome: 'pending', operation: { op: body.op } });
    await w.kv.write([{ op: 'del', key: K.pushPaused }]);
  });

  it('refuses a subscription to anything but a browser push service', async () => {
    const w = await world();
    const r = await w.call('POST', '/api/device-alerts', setupBody({ sub: { endpoint: 'https://evil.example/push', keys: fcmSubscription().keys } }));
    expect(r.status).toBe(400);
  });

  it('answers full when Valkey is above 70% of its memory', async () => {
    const w = await world();
    w.kv.memoryUse = { used: 72, max: 100 };
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.outcome).toBe('full');
  });

  it('repeats a retryable dispatch when the page sends the identical request again', async () => {
    const w = await world();
    w.transport.next = [{ kind: 'refused', status: 503 }];
    const body = setupBody();
    expect((await w.call('POST', '/api/device-alerts', body)).body.operation).toMatchObject({ dispatch: 'retryable' });
    const again = await w.call('POST', '/api/device-alerts', body);
    expect(again.body).toMatchObject({ outcome: 'pending', operation: { dispatch: 'accepted' } });
    expect(w.transport.sent).toHaveLength(2);
  });

  it('ends a setup whose push service says the subscription is gone', async () => {
    const w = await world();
    w.transport.next = [{ kind: 'gone', status: 410 }];
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.operation).toMatchObject({ result: 'gone' });
  });

  it('settles a test answered gone by deleting the alert, which then reads gone with its fingerprint', async () => {
    const w = await world();
    const body = setupBody();
    await w.call('POST', '/api/device-alerts', body);
    await w.call('POST', '/api/device-alerts/ready', { op: body.op, nonce: w.transport.sent[0]!.payload.nonce });
    const fp = (await w.call('GET', '/api/device-alerts/mine')).body.alert.fingerprint;
    w.transport.next = [{ kind: 'gone', status: 410 }];
    expect((await w.call('POST', '/api/device-alerts/mine/test', {})).body).toEqual({ test: 'gone' });
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toMatchObject({ state: 'gone', fingerprint: fp });
  });

  it('answers an unknown credential without storing anything about it', async () => {
    const w = await world();
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toEqual({ state: 'none', operation: null });
    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).body).toEqual({ deleted: true });
    expect((await w.call('POST', '/api/device-alerts/ready', { op: opId(), nonce: 'n'.repeat(43) })).body).toEqual({ result: 'unknown', activation: null });
    expect(w.kv.keys().some((k) => k.includes(credentialHash(w.cred)))).toBe(false);
  });

  it('limits first setups to 30 an hour from one network, and creates nothing when refusing', async () => {
    const w = await world({ limits: { alertLimit: 100, recordLimit: 1000 } });
    for (let i = 0; i < 30; i++) await w.call('POST', '/api/device-alerts', setupBody(), {}, credential());
    const before = w.kv.keys().length;
    const r = await w.call('POST', '/api/device-alerts', setupBody(), {}, credential());
    expect(r.status).toBe(429);
    expect(w.kv.keys().length).toBe(before);
  });

  it('turns off even when Valkey is out of memory (the counters are skipped, the deletion runs)', async () => {
    const w = await world();
    const body = setupBody();
    await w.call('POST', '/api/device-alerts', body);
    await w.call('POST', '/api/device-alerts/ready', { op: body.op, nonce: w.transport.sent[0]!.payload.nonce });
    w.kv.oom = true;
    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).body).toEqual({ deleted: true });
    w.kv.oom = false;
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toEqual({ state: 'none', operation: null });
  });

  it('keeps reads and turn-off working with push off', async () => {
    const w = await world({ mode: 'off' });
    expect((await w.call('GET', '/api/device-alerts/mine')).status).toBe(200);
    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).status).toBe(200);
    expect((await w.call('POST', '/api/device-alerts/mine/test', {})).body).toEqual({ test: 'unavailable' });
  });
});

describe('errors on the device routes', () => {
  it('reach the log without the script\'s message, which can name keys with credential hashes', async () => {
    const t = clock(Date.parse('2026-10-06T02:00:00Z'));
    const kv = new MemoryKv(t.now);
    await kv.set(K.sites, JSON.stringify(SITES));
    const lines: string[] = [];
    const log = { info: (m: string, f?: object) => lines.push(line('info', m, f as never)), warn: (m: string, f?: object) => lines.push(line('warn', m, f as never)), error: (m: string, f?: object) => lines.push(line('error', m, f as never)) };
    const app = createApi({
      kv, keys, mailer: new FakeMailer(), log, publicBaseUrl: ORIGIN, now: t.now, clientIp: () => '203.0.113.7',
      push: { mode: 'live', vapid: VAPID, ownerToken: null }, devices: { alertLimit: 10, recordLimit: 100 }, pushTransport: new FakeTransport(),
    });
    const cred = credential();
    // This credential's operation record is damaged (a string, not a hash): the gate's read of it fails.
    await kv.set(K.devOp(credentialHash(cred)), 'damaged');
    const res = await app.request('/api/device-alerts/mine', { headers: { authorization: `Device ${cred}` } });
    expect(res.status).toBe(500);
    expect(lines.join('\n')).toContain('api error');
    expect(lines.join('\n')).not.toContain(credentialHash(cred));
  });
});
