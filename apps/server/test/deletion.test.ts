import { describe, expect, it } from 'vitest';
import { createApi, DELETION_MESSAGE } from '../src/api.ts';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { confirm, createDeletion, createPending, deleteWithToken, PENDING_TTL_SECONDS } from '../src/subscribers.ts';
import { clock, FakeMailer, keys, MemoryKv } from './helpers.ts';

async function setup() {
  const t = clock(Date.parse('2026-10-01T00:00:00Z'));
  const kv = new MemoryKv(t.now);
  const mailer = new FakeMailer();
  const app = createApi({ kv, keys, mailer, log: silentLog, publicBaseUrl: 'https://penge.example', now: t.now, clientIp: () => '203.0.113.5' });
  const post = (path: string, body: unknown, type = 'application/json') => app.request(path, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  const join = async (email = 'juan@example.com') => {
    const token = await createPending(kv, keys, { email, siteIds: [486], applicants: 1, pace: 'hourly', channels: null }, t.now());
    const result = await confirm(kv, keys, token, t.now());
    if (result.status !== 'confirmed' && result.status !== 'updated') throw new Error(`fixture confirmation failed: ${result.status}`);
    return result.subscriberId;
  };
  return { t, kv, mailer, app, post, join };
}
const deletionToken = (text: string) => /\/delete-data#token=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

describe('deletion recovery without an alert email', () => {
  it('sends identical responses/content to subscribed and unknown addresses without needing a site list', async () => {
    const s = await setup();
    await s.join();
    for (const email of [' Juan@Example.com ', 'unknown@example.com']) {
      const response = await s.post('/api/deletion-request', { email });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ message: DELETION_MESSAGE });
    }
    expect(s.mailer.sent.map((mail) => mail.to)).toEqual(['juan@example.com', 'unknown@example.com']);
    expect(s.mailer.sent.every((mail) => mail.kind === 'deletion')).toBe(true);
    expect(s.mailer.sent[0]!.text.replace(deletionToken(s.mailer.sent[0]!.text), 'TOKEN')).toBe(s.mailer.sent[1]!.text.replace(deletionToken(s.mailer.sent[1]!.text), 'TOKEN'));
    expect(s.kv.dump()).not.toContain('juan@example.com');
    expect(s.kv.dump()).not.toContain(deletionToken(s.mailer.sent[0]!.text));
    expect(await s.kv.sMembers(K.allSubscribers)).toHaveLength(1); // request does not delete
  });

  it('deletes choices, held alerts and all unused links only after a valid POST', async () => {
    const s = await setup();
    const id = await s.join();
    await s.kv.set(K.held(id), 'held');
    await s.kv.write([{ op: 'sAdd', key: K.heldSubscribers, members: [id] }]);
    const pending = await createPending(s.kv, keys, { email: 'juan@example.com', siteIds: [10], applicants: 2, pace: 'asap', channels: null }, s.t.now());
    await s.post('/api/deletion-request', { email: 'juan@example.com' });
    const token = deletionToken(s.mailer.sent[0]!.text);
    const other = await createDeletion(s.kv, keys, 'juan@example.com');
    expect((await s.app.request(`/api/delete-data?token=${token}`)).status).toBe(404);
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([id]);
    expect((await s.post('/api/delete-data', { token: 'A'.repeat(43) })).status).toBe(404);
    expect((await s.post('/api/delete-data', { token })).status).toBe(200);
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([]);
    expect(await s.kv.sMembers(K.siteSubscribers(486))).toEqual([]);
    expect(await s.kv.get(K.held(id))).toBeNull();
    expect(await s.kv.sMembers(K.heldSubscribers)).toEqual([]);
    expect((await confirm(s.kv, keys, pending, s.t.now())).status).toBe('invalid');
    expect((await deleteWithToken(s.kv, other)).valid).toBe(false);
    expect((await s.post('/api/delete-data', { token })).status).toBe(404);
  });

  it('also cancels an unconfirmed signup and succeeds for an unknown address', async () => {
    const s = await setup();
    const pending = await createPending(s.kv, keys, { email: 'juan@example.com', siteIds: [10], applicants: 1, pace: 'hourly', channels: null }, s.t.now());
    const token = await createDeletion(s.kv, keys, 'juan@example.com');
    expect(await deleteWithToken(s.kv, token)).toEqual({ valid: true, removed: false });
    expect((await confirm(s.kv, keys, pending, s.t.now())).status).toBe('invalid');
    const unknown = await createDeletion(s.kv, keys, 'unknown@example.com');
    expect((await s.post('/api/delete-data', { token: unknown })).status).toBe(200);
  });

  it('serializes deletion with confirmation so an old link cannot resurrect the subscription', async () => {
    const s = await setup();
    await s.join();
    const pending = await createPending(s.kv, keys, { email: 'juan@example.com', siteIds: [10], applicants: 1, pace: 'hourly', channels: null }, s.t.now());
    const deletion = await createDeletion(s.kv, keys, 'juan@example.com');
    await Promise.all([confirm(s.kv, keys, pending, s.t.now()), deleteWithToken(s.kv, deletion)]);
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([]);
    expect(await s.kv.sMembers(K.siteSubscribers(10))).toEqual([]);
  });

  it('expires recovery links after 48 hours without deleting anything', async () => {
    const s = await setup();
    const id = await s.join();
    const token = await createDeletion(s.kv, keys, 'juan@example.com');
    s.t.advance(PENDING_TTL_SECONDS * 1000);
    expect((await s.post('/api/delete-data', { token })).status).toBe(404);
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([id]);
  });

  it('limits email sends silently, rejects injection/invalid forms and honours mail pause', async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) expect((await s.post('/api/deletion-request', { email: 'juan@example.com' })).status).toBe(202);
    expect(s.mailer.sent).toHaveLength(3);
    expect((await s.post('/api/deletion-request', { email: 'a@b.co\r\nBcc: victim@b.co' })).status).toBe(400);
    expect((await s.post('/api/deletion-request', { email: 'unknown@example.com' }, 'text/plain')).status).toBe(415);
    await s.post('/api/deletion-request', { email: 'unknown@example.com', website: 'bot' });
    expect(s.mailer.sent).toHaveLength(3);
    await s.kv.set(K.mailPaused, '1');
    expect((await s.post('/api/deletion-request', { email: 'unknown@example.com' })).status).toBe(503);
  });

  it('keeps an existing direct unsubscribe working while cancelling recovery links', async () => {
    const { signUnsubscribe } = await import('../src/crypto.ts');
    const s = await setup();
    const id = await s.join();
    const token = await createDeletion(s.kv, keys, 'juan@example.com');
    expect((await s.post('/api/unsubscribe', { token: signUnsubscribe(id, keys.token) })).status).toBe(200);
    expect((await deleteWithToken(s.kv, token)).valid).toBe(false);
  });
});
