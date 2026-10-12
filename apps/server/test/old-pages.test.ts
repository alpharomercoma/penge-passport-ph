// Pages of the channel release (05cee09) stay open in people's browsers after the deploy. Their email requests must
// keep working against the exact answers of that release's contracts; anything about notifications is refused
// before anything is written.
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import type { PushConfig } from '../src/config.ts';
import { hashToken } from '../src/crypto.ts';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { createPending } from '../src/subscribers.ts';
import { clock, confirmToken, FakeMailer, keys, MemoryKv } from './helpers.ts';

const SITES = [{ id: 486, name: 'Antipolo' }, { id: 693, name: 'Pampanga' }];
const off: PushConfig = { mode: 'off', vapid: null, ownerToken: null };

async function setup(push = off) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  await kv.set(K.sites, JSON.stringify(SITES));
  const mailer = new FakeMailer();
  const app = createApi({ kv, keys, mailer, log: silentLog, publicBaseUrl: 'https://penge.example', now: t.now, clientIp: () => '203.0.113.7', push });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { t, kv, mailer, app, post };
}

const form = { email: 'juan@example.com', siteIds: [486], applicants: 2, pace: 'asap' };

describe('pages of the channel release', () => {
  it('get an email-only preview as "a request from before channels"', async () => {
    const s = await setup();
    await s.post('/api/subscribe', { ...form, channels: { emailOn: true, pushOn: false } });
    const token = confirmToken(s.mailer.sent[0]!.text)!;
    const res = await s.post('/api/confirm/preview', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteIds: [486], applicants: 2, pace: 'asap', channels: null });
    expect((await s.post('/api/confirm/preview', { token: 'x'.repeat(43) })).status).toBe(404);
  });

  it('confirm with their acknowledgement, and read email channels in the answer', async () => {
    const s = await setup();
    await s.post('/api/subscribe', { ...form, channels: { emailOn: true, pushOn: false } });
    const token = confirmToken(s.mailer.sent[0]!.text)!;
    const res = await s.post('/api/confirm', { token, acknowledge: { emailOn: true, pushOn: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'confirmed', siteIds: [486], applicants: 2, pace: 'asap', channels: { emailOn: true, pushOn: false, push: 'none' } });
  });

  it.each([
    ['notifications on', { emailOn: true, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null }],
    ['email off', { emailOn: false, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null }],
    ['both off', { emailOn: false, pushOn: false }],
  ])('are told to reload when they ask for %s, and nothing is written or sent', async (_, channels) => {
    const s = await setup();
    const res = await s.post('/api/subscribe', { ...form, channels });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This page is out of date. Reload it.', code: 'reload' });
    expect(s.mailer.sent).toEqual([]);
    expect(s.kv.keys().filter((k) => !k.startsWith('pp:rate:') && k !== K.sites)).toEqual([]);
  });

  it('never confirm a pending request the channel release stored with email off', async () => {
    const s = await setup();
    const token = await createPending(s.kv, keys, { ...form, pace: 'asap' } as never, s.t.now());
    const key = K.pending(hashToken(token));
    const stored = JSON.parse((await s.kv.get(key))!) as Record<string, unknown>;
    await s.kv.set(key, JSON.stringify({ ...stored, channels: { emailOn: false, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null } }), { ttlSeconds: 3600 });
    expect((await s.post('/api/confirm', { token })).status).toBe(404);
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([]);
  });

  it.each([
    ['null channels', null],
    ['a malformed notifications flag', { emailOn: true, pushOn: 'false' }],
  ])('never confirm or preview a pending request with %s, and never fail on it', async (_, channels) => {
    const s = await setup();
    const token = await createPending(s.kv, keys, { ...form, pace: 'asap' } as never, s.t.now());
    const key = K.pending(hashToken(token));
    const stored = JSON.parse((await s.kv.get(key))!) as Record<string, unknown>;
    await s.kv.set(key, JSON.stringify({ ...stored, channels }), { ttlSeconds: 3600 });
    expect((await s.post('/api/confirm/preview', { token })).status).toBe(404);
    expect((await s.post('/api/confirm', { token })).status).toBe(404);
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([]);
  });

  it.each([
    ['POST', '/api/push/device'],
    ['DELETE', '/api/push/device'],
    ['POST', '/api/push/test'],
  ])('get 410 and "reload" from %s %s', async (method, path) => {
    const s = await setup();
    const res = await s.app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'c'.repeat(43) }) });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'This page is out of date. Reload it.', code: 'reload' });
  });

  it('read push mode and the VAPID key from the status', async () => {
    const s = await setup({ mode: 'owner', vapid: { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), subject: 'mailto:alerts@example.com' }, ownerToken: 't'.repeat(40) });
    const body = (await (await s.app.request('/api/status')).json()) as Record<string, unknown>;
    expect([body.push, body.vapidPublicKey]).toEqual(['owner', 'B'.repeat(87)]);
    const offBody = (await (await (await setup()).app.request('/api/status')).json()) as Record<string, unknown>;
    expect([offBody.push, offBody.vapidPublicKey]).toEqual(['off', null]);
  });
});

describe('pages of the release before push (157bad9)', () => {
  it('confirm with a bare token and get the answer they know, with channels they ignore', async () => {
    const s = await setup();
    await s.post('/api/subscribe', form);
    const token = confirmToken(s.mailer.sent[0]!.text)!;
    const res = await s.post('/api/confirm', { token });
    expect(await res.json()).toMatchObject({ status: 'confirmed', siteIds: [486], applicants: 2, pace: 'asap' });
  });
});
