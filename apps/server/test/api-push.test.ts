import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import type { PushConfig } from '../src/config.ts';
import { K } from '../src/keys.ts';
import { MemoryKv } from '../src/kv.ts';
import type { PushTransport } from '../src/push/sender.ts';
import { silentLog } from '../src/log.ts';
import { emailIndex } from '../src/crypto.ts';
import { clock, FakeMailer, fcmSubscription, keys, PUSH_KEYS, SITES } from './helpers.ts';

const PHONE = 'Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile';
const VAPID = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), subject: 'mailto:alerts@example.com' };
const LIVE: PushConfig = { mode: 'live', vapid: VAPID, ownerEmails: [] };
type Ch = { emailOn: boolean; pushOn: boolean; pushCredentialHash?: string; device?: string };

export async function site(push: PushConfig = LIVE, pushTransport?: PushTransport) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  await kv.set(K.sites, JSON.stringify(SITES.map((s) => ({ id: s.id, name: s.name }))));
  const mailer = new FakeMailer();
  let ip = '203.0.113.1';
  const app = createApi({ kv, keys, mailer, log: silentLog, publicBaseUrl: 'https://penge.example', now: t.now, clientIp: () => ip, push, ...(pushTransport ? { pushTransport } : {}) } as Parameters<typeof createApi>[0]);
  const send = (method: string, path: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', 'user-agent': PHONE }, body: JSON.stringify(body) });
  const post = (path: string, body: unknown) => send('POST', path, body);
  const state = async (body: unknown) => ((await (await post('/api/push/device', body)).json()) as { state: string }).state;
  const credential = () => {
    const c = randomBytes(32).toString('base64url');
    return { credential: c, hash: createHash('sha256').update(c).digest('base64url') };
  };
  const signUp = async (email: string, channels: Ch) => {
    const res = await post('/api/subscribe', { email, siteIds: [693], applicants: 1, pace: 'asap', channels });
    expect(res.status).toBe(202);
    const token = /\/confirm#token=([A-Za-z0-9_-]{43})/.exec(mailer.sent.at(-1)!.text)![1]!;
    return { token, confirm: () => post('/api/confirm', { token, acknowledge: { emailOn: channels.emailOn, pushOn: channels.pushOn } }) };
  };
  return { t, kv, mailer, app, send, post, state, credential, signUp, setIp: (v: string) => (ip = v) };
}

describe('push API', () => {
  it('previews then confirms a push-only request, and a token-only confirm of it gets 409 without using it', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { token } = await s.signUp('juan@example.com', { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    const preview = (await (await s.post('/api/confirm/preview', { token })).json()) as { channels: unknown };
    expect(preview.channels).toMatchObject({ emailOn: false, pushOn: true, device: 'Chrome on Android', pushCredentialHash: hash });
    const old = await s.post('/api/confirm', { token });
    expect(old.status).toBe(409);
    expect(((await old.json()) as { code: string }).code).toBe('reload');
    const ok = await s.post('/api/confirm', { token, acknowledge: { emailOn: false, pushOn: true } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { channels: unknown }).channels).toEqual({ emailOn: false, pushOn: true, push: 'bound' });
    expect(await s.state({ credential })).toBe('awaiting');
  });

  it('answers pending before confirmation, registers after, and refuses an old revision as stale', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { confirm } = await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    expect(await s.state({ credential })).toBe('pending');
    expect((await confirm()).status).toBe(200);
    expect(await s.state({ credential })).toBe('awaiting');
    const a = fcmSubscription('a');
    expect(await s.state({ credential, subscription: a, revision: 1 })).toBe('registered');
    expect(await s.state({ credential, subscription: a, revision: 1 })).toBe('registered');
    expect(await s.state({ credential, subscription: { ...a, keys: { ...a.keys, auth: Buffer.alloc(16, 2).toString('base64url') } }, revision: 1 })).toBe('stale');
    expect(await s.state({ credential, subscription: fcmSubscription('b'), revision: 2 })).toBe('registered');
    expect(await s.state({ credential })).toBe('registered');
  });

  it('refuses a push endpoint outside the push services, or a bad key, with 400', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { confirm } = await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    await confirm();
    expect((await s.post('/api/push/device', { credential, subscription: { endpoint: 'https://127.0.0.1/x', keys: PUSH_KEYS }, revision: 1 })).status).toBe(400);
    expect((await s.post('/api/push/device', { credential, subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { ...PUSH_KEYS, p256dh: Buffer.alloc(65, 4).toString('base64url') } }, revision: 1 })).status).toBe(400);
  });

  it('turns a device off, and a second confirmation cannot bring the credential back', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const ch = { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    const first = await s.signUp('juan@example.com', ch);
    const second = await s.signUp('juan@example.com', ch);
    await first.confirm();
    expect(await (await s.send('DELETE', '/api/push/device', { credential })).json()).toEqual({ ok: true, noChannel: false });
    expect(await s.state({ credential })).toBe('pending'); // the second request is still waiting
    const r = (await (await second.confirm()).json()) as { channels: { push: string } };
    expect(r.channels.push).toBe('skipped-revoked');
    expect(await s.state({ credential })).toBe('missing');
  });

  it('revokes a credential turned off before anyone confirmed', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const ch = { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    const req = await s.signUp('juan@example.com', ch);
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
    const r = (await (await req.confirm()).json()) as { channels: { push: string } };
    expect(r.channels.push).toBe('skipped-revoked');
  });

  it('turns off a device whose confirmation died after binding, and a retried confirmation cannot leave push-only with no device', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { token } = await s.signUp('juan@example.com', { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    const write = s.kv.write.bind(s.kv);
    s.kv.write = async (ops) => {
      if (ops.some((o) => o.op === 'hSet' && o.key.startsWith('pp:sub:'))) throw new Error('process died');
      return write(ops);
    };
    expect((await s.post('/api/confirm', { token, acknowledge: { emailOn: false, pushOn: true } })).status).toBe(500);
    s.kv.write = write;
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
    const retry = await s.post('/api/confirm', { token, acknowledge: { emailOn: false, pushOn: true } });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { code: string }).code).toBe('push-unavailable');
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([]);
  });

  it('takes the right address lock when one browser has requests pending for two addresses', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const ch = { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    await s.signUp('ana@example.com', ch);
    const ben = await s.signUp('ben@example.com', ch);
    const write = s.kv.write.bind(s.kv);
    s.kv.write = async (ops) => {
      if (ops.some((o) => o.op === 'hSet' && o.key.startsWith('pp:sub:'))) throw new Error('process died');
      return write(ops);
    };
    expect((await s.post('/api/confirm', { token: ben.token, acknowledge: { emailOn: false, pushOn: true } })).status).toBe(500);
    s.kv.write = write;
    // The device belongs to ben's address: turning it off must use that lock, whatever ana's request says.
    const locks: string[] = [];
    const set = s.kv.set.bind(s.kv);
    s.kv.set = async (key, value, opts) => {
      if (key.startsWith('pp:lock:idx:')) locks.push(key);
      return set(key, value, opts);
    };
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
    const benIndex = (await s.kv.keys()).find((k) => k.startsWith('pp:push:address:'));
    expect(benIndex).toBeUndefined(); // removed with the device
    expect(locks).toHaveLength(1);
    expect(locks[0]).toBe(`pp:lock:idx:${emailIndex('ben@example.com', keys.index)}`);
  });

  it('writes nothing when the address was deleted while turning off waited', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    await (await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' })).confirm();
    const ids = await s.kv.sMembers(K.allSubscribers);
    const del = await s.post('/api/deletion-request', { email: 'juan@example.com' });
    expect(del.status).toBe(202);
    const delToken = /#token=([A-Za-z0-9_-]{43})/.exec(s.mailer.sent.at(-1)!.text)![1];
    await Promise.all([s.post('/api/delete-data', { token: delToken }), s.send('DELETE', '/api/push/device', { credential })]);
    expect(await s.kv.hGetAll(K.subscriber(ids[0]!))).toEqual({});
  });

  it('says when turning off the last device leaves no channel', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    await (await s.signUp('juan@example.com', { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' })).confirm();
    expect(await (await s.send('DELETE', '/api/push/device', { credential })).json()).toEqual({ ok: true, noChannel: true });
  });

  it('in owner mode accepts push sign-ups only for owner addresses, and says owner in the status', async () => {
    const s = await site({ mode: 'owner', vapid: VAPID, ownerEmails: ['juan@example.com'] });
    const status = (await (await s.app.request('/api/status', { headers: { 'user-agent': PHONE } })).json()) as { push: string; vapidPublicKey: string };
    expect(status).toMatchObject({ push: 'owner', vapidPublicKey: VAPID.publicKey });
    const { hash } = s.credential();
    const channels = { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    const other = await s.post('/api/subscribe', { email: 'ana@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { fields: { channels: string } }).fields.channels).toMatch(/not available/);
    expect((await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels })).status).toBe(202);
  });

  it('refuses push sign-ups when push is off, and still takes email-only ones', async () => {
    const s = await site({ mode: 'off', vapid: null, ownerEmails: [] });
    const { hash } = s.credential();
    expect((await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } })).status).toBe(400);
    expect((await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: false } })).status).toBe(202);
  });

  it('lets two views wait for a confirmation for an hour, and turning off still works after', async () => {
    const s = await site();
    const { credential } = s.credential();
    // The sheet and the row each ask every 30 s: 240 calls in the hour.
    for (let i = 0; i < 240; i++) {
      expect((await s.post('/api/push/device', { credential })).status).toBe(200);
      s.t.advance(15_000);
    }
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
  });

  it('rate-limits device calls per credential and per network, but never blocks turning off', async () => {
    const s = await site();
    const one = s.credential();
    for (let i = 0; i < 300; i++) expect((await s.post('/api/push/device', { credential: one.credential })).status).toBe(200);
    s.setIp('203.0.113.2');
    expect((await s.post('/api/push/device', { credential: one.credential })).status).toBe(429); // per credential
    expect((await s.send('DELETE', '/api/push/device', { credential: one.credential })).status).toBe(200); // turning off still works
    for (let i = 0; i < 598; i++) await s.post('/api/push/device', { credential: s.credential().credential });
    expect((await s.post('/api/push/device', { credential: s.credential().credential })).status).toBe(429); // 600 from this network
  });
});

describe('turning off while a confirmation finishes', () => {
  it('never removes a device outside its address lock, even when the confirmation commits between reads', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const ch = { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    const { token } = await s.signUp('juan@example.com', ch);
    const write = s.kv.write.bind(s.kv);
    s.kv.write = async (ops) => {
      if (ops.some((o) => o.op === 'hSet' && o.key.startsWith('pp:sub:'))) throw new Error('process died');
      return write(ops);
    };
    await s.post('/api/confirm', { token, acknowledge: { emailOn: true, pushOn: true } }); // bound, then died
    s.kv.write = write;
    const lock = `pp:lock:idx:${emailIndex('juan@example.com', keys.index)}`;
    // The retried confirmation commits right after turning off first reads the subscriber outside the lock.
    const hGetAll = s.kv.hGetAll.bind(s.kv);
    let fired = false;
    s.kv.hGetAll = async (key) => {
      const v = await hGetAll(key);
      if (!fired && key.startsWith('pp:sub:') && !(await s.kv.get(lock))) {
        fired = true;
        expect((await s.post('/api/confirm', { token, acknowledge: { emailOn: true, pushOn: true } })).status).toBe(200);
      }
      return v;
    };
    const locked: boolean[] = [];
    const script = s.kv.script.bind(s.kv);
    s.kv.script = async (def, k, a) => {
      if (def.name === 'pushRemove') locked.push((await s.kv.get(lock)) !== null);
      return script(def, k, a);
    };
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every(Boolean)).toBe(true);
    // Not run inside the read: the retry comes after, and keeps email only.
    if (!fired) expect((await s.post('/api/confirm', { token, acknowledge: { emailOn: true, pushOn: true } })).status).toBe(200);
    const ids = await s.kv.sMembers(K.allSubscribers);
    expect(await hGetAll(K.pushMeta(ids[0]!))).toEqual({});
    expect((await hGetAll(K.subscriber(ids[0]!))).pushOn).toBe('0');
  });
});

it('sends a test notification to the requesting device only, three an hour', async () => {
  const sent: string[] = [];
  const transport = { async send(s: { endpoint: string }) { sent.push(s.endpoint); } };
  const s = await site(undefined, transport);
  const a = s.credential();
  const b = s.credential();
  await (await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: a.hash, device: 'Chrome on Android' })).confirm();
  await (await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: b.hash, device: 'Firefox on Mac' })).confirm();
  expect((await s.post('/api/push/test', { credential: a.credential })).status).toBe(404); // not registered yet
  await s.post('/api/push/device', { credential: a.credential, subscription: fcmSubscription('phone'), revision: 1 });
  await s.post('/api/push/device', { credential: b.credential, subscription: fcmSubscription('mac'), revision: 1 });
  for (let i = 0; i < 3; i++) expect((await s.post('/api/push/test', { credential: a.credential })).status).toBe(200);
  expect((await s.post('/api/push/test', { credential: a.credential })).status).toBe(429);
  expect(sent).toEqual(Array(3).fill('https://fcm.googleapis.com/fcm/send/phone'));
  await s.kv.set(K.pushPaused, '1');
  s.setIp('203.0.113.9');
  expect((await s.post('/api/push/test', { credential: b.credential })).status).toBe(503);
  expect(sent).toHaveLength(3);
});
