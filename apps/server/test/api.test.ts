import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clientAddress, createApi, SUBSCRIBE_MESSAGE, unsubscribeLinks } from '../src/api.ts';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { FakeMailer, keys, MemoryKv, SITES } from './helpers.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const BASE = 'https://penge.example';

async function setup(opts: { sites?: boolean; mode?: 'live' | 'dry-run' } = {}) {
  const kv = new MemoryKv();
  const mailer = new FakeMailer(opts.mode ?? 'live');
  if (opts.sites !== false) {
    await kv.set(K.sites, JSON.stringify(SITES.map(({ id, name }) => ({ id, name }))));
  }
  let ip = '203.0.113.7';
  const app = createApi({ kv, keys, mailer, log: silentLog, publicBaseUrl: BASE, clientIp: () => ip });
  const post = (path: string, body: unknown, type = 'application/json') =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { kv, mailer, app, post, setIp: (next: string) => (ip = next) };
}

const confirmToken = (text: string) => /\/confirm#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];

describe('subscribe, confirm, unsubscribe', () => {
  it('runs the whole double opt-in flow and stores the address only encrypted', async () => {
    const { kv, mailer, post } = await setup();
    const res = await post('/api/subscribe', { email: 'Juan@Example.com', siteIds: [693, 486], applicants: 2 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ message: SUBSCRIBE_MESSAGE });
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('juan@example.com');
    expect(mail.kind).toBe('confirm');
    expect(mail.unsubscribeUrl).toBeUndefined();
    expect(mail.text).toContain('Antipolo (SM Center, Antipolo City, Rizal)');
    expect(mail.text).toContain('2 people');

    // Nothing is subscribed until the link is used.
    expect(await kv.sMembers(K.siteSubscribers(486))).toEqual([]);

    const token = confirmToken(mail.text)!;
    const ok = await post('/api/confirm', { token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'confirmed', siteIds: [486, 693], applicants: 2 });
    const [id] = await kv.sMembers(K.siteSubscribers(486));
    expect(await kv.sMembers(K.siteSubscribers(693))).toEqual([id]);

    // The token works once.
    expect((await post('/api/confirm', { token })).status).toBe(404);

    // The address never appears in the database in any readable form.
    const dump = kv.dump();
    expect(dump).not.toContain('juan@example.com');
    expect(dump.toLowerCase()).not.toContain('juan');
    expect(dump).not.toContain(token);

    const links = unsubscribeLinks(BASE, id!, keys);
    const token2 = links.page.split('#token=')[1];
    const bye = await post('/api/unsubscribe', { token: token2 });
    expect(bye.status).toBe(200);
    expect(await kv.sMembers(K.siteSubscribers(486))).toEqual([]);
    expect(kv.keys().filter((k) => /:(sub|idx|site):/.test(k))).toEqual([]);
    // Again: same answer, nothing to remove.
    expect((await post('/api/unsubscribe', { token: token2 })).status).toBe(200);
  });

  it('replaces the sites of an existing subscriber on a new confirmation', async () => {
    const { kv, mailer, post } = await setup();
    await post('/api/subscribe', { email: 'a@b.co', siteIds: [10, 486] });
    await post('/api/confirm', { token: confirmToken(mailer.sent[0]!.text) });
    const [id] = await kv.sMembers(K.siteSubscribers(10));
    await post('/api/subscribe', { email: 'A@B.CO', siteIds: [693] });
    const res = await post('/api/confirm', { token: confirmToken(mailer.sent[1]!.text) });
    expect(await res.json()).toMatchObject({ status: 'updated', siteIds: [693] });
    expect(await kv.sMembers(K.siteSubscribers(10))).toEqual([]);
    expect(await kv.sMembers(K.siteSubscribers(486))).toEqual([]);
    expect(await kv.sMembers(K.siteSubscribers(693))).toEqual([id]);
  });

  it('honours RFC 8058 one-click unsubscribe, and never unsubscribes on a GET', async () => {
    const { kv, mailer, app, post } = await setup();
    await post('/api/subscribe', { email: 'a@b.co', siteIds: [10] });
    await post('/api/confirm', { token: confirmToken(mailer.sent[0]!.text) });
    const [id] = await kv.sMembers(K.siteSubscribers(10));
    const { oneClick } = unsubscribeLinks(BASE, id!, keys);
    const path = oneClick.slice(BASE.length);

    const get = await app.request(path);
    expect(get.status).toBe(303);
    expect(get.headers.get('location')).toMatch(/^https:\/\/penge\.example\/unsubscribe#token=/);
    expect(await kv.sMembers(K.siteSubscribers(10))).toEqual([id]);

    expect((await post(path, 'List-Unsubscribe=Something', 'application/x-www-form-urlencoded')).status).toBe(400);
    expect(await kv.sMembers(K.siteSubscribers(10))).toEqual([id]);

    const res = await post(path, 'List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
    expect(await kv.sMembers(K.siteSubscribers(10))).toEqual([]);
  });

  it('rejects forged unsubscribe tokens', async () => {
    const { post } = await setup();
    const forged = `${'A'.repeat(22)}.${'B'.repeat(43)}`;
    expect((await post('/api/unsubscribe', { token: forged })).status).toBe(200);
    expect((await post('/api/unsubscribe', { token: 'nope' })).status).toBe(400);
  });
});

describe('input checks', () => {
  it.each([
    [{ email: 'bad', siteIds: [10] }, 400, 'email'],
    [{ email: 'a@b.co', siteIds: [999] }, 400, 'siteIds'],
    [{ email: 'a@b.co', siteIds: [10], applicants: 99 }, 400, 'applicants'],
    [{ email: 'a@b.co', siteIds: [10], website: 'x' }, 400, 'form'],
    [[1, 2], 400, 'form'],
  ])('refuses %j', async (body, status, field) => {
    const { mailer, post } = await setup();
    const res = await post('/api/subscribe', body);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { fields?: object }).fields).toHaveProperty(field);
    expect(mailer.sent).toHaveLength(0);
  });

  it('accepts only JSON, and only small bodies', async () => {
    const { post } = await setup();
    expect((await post('/api/subscribe', 'email=a@b.co', 'application/x-www-form-urlencoded')).status).toBe(415);
    expect((await post('/api/subscribe', 'email=a@b.co', 'text/plain')).status).toBe(415);
    expect((await post('/api/subscribe', '{"email":')).status).toBe(400);
    expect((await post('/api/subscribe', { email: 'a@b.co', siteIds: [10], pad: 'x'.repeat(5000) })).status).toBe(413);
    expect((await post('/api/confirm', { token: 'short' })).status).toBe(400);
  });

  it('says so when the checker has not stored a site list yet', async () => {
    const { post } = await setup({ sites: false });
    expect((await post('/api/subscribe', { email: 'a@b.co', siteIds: [10] })).status).toBe(503);
  });

  it('sends no confirmation while mail is paused', async () => {
    const { kv, mailer, post } = await setup();
    await kv.set(K.mailPaused, '1');
    expect((await post('/api/subscribe', { email: 'a@b.co', siteIds: [10] })).status).toBe(503);
    expect(mailer.sent).toHaveLength(0);
  });

  it('is ready only when Redis answers', async () => {
    const { kv, app } = await setup();
    expect((await app.request('/api/ready')).status).toBe(200);
    kv.get = async () => {
      throw new Error('connection lost');
    };
    expect((await app.request('/api/ready')).status).toBe(503);
  });

  it('stores nothing while mail is not live', async () => {
    const { kv, mailer, post } = await setup({ mode: 'dry-run' });
    const before = kv.dump();
    const res = await post('/api/subscribe', { email: 'a@b.co', siteIds: [10] });
    expect(res.status).toBe(503);
    expect(mailer.sent).toHaveLength(0);
    expect(kv.dump()).toBe(before);
  });

  it('reports whether mail is live', async () => {
    expect(await (await (await setup()).app.request('/api/status')).json()).toMatchObject({ mailLive: true, healthy: false });
    expect(await (await (await setup({ mode: 'dry-run' })).app.request('/api/status')).json()).toMatchObject({ mailLive: false });
  });

  it('sets safe headers on every answer', async () => {
    const res = await (await setup()).app.request('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('abuse limits', () => {
  it('limits form posts per network address', async () => {
    const { post, setIp } = await setup();
    for (let i = 0; i < 10; i++) {
      expect((await post('/api/subscribe', { email: `p${i}@b.co`, siteIds: [10] })).status).toBe(202);
    }
    expect((await post('/api/subscribe', { email: 'p10@b.co', siteIds: [10] })).status).toBe(429);
    setIp('198.51.100.1');
    expect((await post('/api/subscribe', { email: 'p10@b.co', siteIds: [10] })).status).toBe(202);
  });

  it('keeps its per-address counters without storing any IP address', async () => {
    const { kv, post, setIp } = await setup();
    setIp('198.51.100.77');
    await post('/api/subscribe', { email: 'ana@b.co', siteIds: [10] });
    const rateKeys = kv.keys().filter((k) => k.startsWith('pp:rate:'));
    expect(rateKeys.length).toBeGreaterThan(0);
    expect(kv.dump()).not.toContain('198.51.100.77');
  });

  it('sends at most 3 confirmations a day to one address, without saying so', async () => {
    const { mailer, post, setIp } = await setup();
    for (let i = 0; i < 5; i++) {
      setIp(`198.51.100.${i}`);
      const res = await post('/api/subscribe', { email: 'target@b.co', siteIds: [10] });
      expect(res.status).toBe(202);
    }
    expect(mailer.sent).toHaveLength(3);
  });

  it('answers 503, not 202, when the confirmation email cannot be sent', async () => {
    const { mailer, post } = await setup();
    mailer.failNext = 1;
    expect((await post('/api/subscribe', { email: 'a@b.co', siteIds: [10] })).status).toBe(503);
  });
});

describe('client address', () => {
  it.each([
    ['127.0.0.1', '203.0.113.9', '203.0.113.9'],
    ['127.0.0.1', '1.1.1.1, 203.0.113.9', '203.0.113.9'],
    ['::1', '2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['198.51.100.4', '203.0.113.9', '198.51.100.4'],
    ['::ffff:198.51.100.4', undefined, '198.51.100.4'],
    ['2001:db8::1', undefined, '2001:db8:0:0::/64'],
  ])('peer %s, forwarded %s → %s', (peer, forwarded, expected) => {
    expect(clientAddress(peer, forwarded)).toBe(expected);
  });
});

describe('fuzz', () => {
  it('never fails with a 500, whatever is sent', async () => {
    const { app, setIp } = await setup();
    let n = 0;
    const path = fc.constantFrom('/api/subscribe', '/api/confirm', '/api/unsubscribe', '/api/unsubscribe?token=x', '/api/sites', '/api/status', '/api/../etc', '/api/%00');
    const type = fc.constantFrom('application/json', 'application/json; charset=utf-8', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '');
    const body = fc.oneof(
      fc.json(),
      fc.string(),
      fc.string({ unit: 'binary', maxLength: 200 }),
      fc.anything().map((v) => {
        try {
          return JSON.stringify(v) ?? '';
        } catch {
          return '';
        }
      }),
      fc.record({ email: fc.anything(), siteIds: fc.anything(), token: fc.anything(), website: fc.anything() }).map((v) => JSON.stringify(v)),
    );
    await fc.assert(
      fc.asyncProperty(path, type, body, fc.constantFrom('GET', 'POST', 'PUT', 'DELETE'), async (p, t, b, method) => {
        // A fresh address each time, so the per-address limits don't hide the handlers.
        n++;
        setIp(`10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
        const res = await app.request(p, {
          method,
          headers: t ? { 'content-type': t } : {},
          ...(method === 'GET' ? {} : { body: b }),
        });
        expect(res.status).not.toBe(500);
        if (res.status !== 303) expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      }),
      { seed: 20260927, numRuns: RUNS },
    );
  }, 10_000 + RUNS * 5);
});

describe('site under a path', () => {
  it('puts the path in every link it makes', async () => {
    const kv = new MemoryKv();
    await kv.set(K.sites, JSON.stringify(SITES.map(({ id, name }) => ({ id, name }))));
    const mailer = new FakeMailer();
    const base = 'https://example.org/pengepassportph';
    const app = createApi({ kv, keys, mailer, log: silentLog, publicBaseUrl: base, clientIp: () => '203.0.113.9' });
    await app.request('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', siteIds: [10] }) });
    expect(mailer.sent[0]!.text).toContain(`${base}/confirm#token=`);
    const links = unsubscribeLinks(base, 'abcdefghijklmnopqrstuv', keys);
    expect(links.page.startsWith(`${base}/unsubscribe#token=`)).toBe(true);
    expect(links.oneClick.startsWith(`${base}/api/unsubscribe?token=`)).toBe(true);
    const res = await app.request(`/api/unsubscribe?token=${links.oneClick.split('token=')[1]}`);
    expect(res.headers.get('location')).toBe(links.page);
  });
});
