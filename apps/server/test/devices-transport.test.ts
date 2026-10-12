import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net';
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { line } from '../src/log.ts';
import { loggable, nodePost, NOT_SENT, SendSlots, webPushTransport } from '../src/devices/transport.ts';
import { subscription } from './device-fixtures.ts';

const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:alerts@example.com' };
const answer = (status: number, headers: Record<string, string> = {}) => async () => new Response('{"reason":"secret body"}', { status, headers });
const send = (f: typeof fetch, deadlineMs = 10_000) => webPushTransport(vapid, { fetch: f, deadlineMs, now: () => Date.parse('2026-10-06T02:00:00Z') }).send(subscription(), '{"v":1}', { ttl: 1800, urgency: 'high' });

describe('the push transport', () => {
  it('signs and encrypts with web-push and posts it once, without following redirects', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await send(async (url, init) => {
      seen = { url: String(url), init: init! };
      return new Response(null, { status: 201 });
    });
    expect(r).toEqual({ kind: 'accepted', status: 201 });
    expect(seen!.url).toMatch(/^https:\/\/fcm\.googleapis\.com\//);
    const h = new Headers(seen!.init.headers);
    expect([h.get('TTL'), h.get('Urgency'), h.get('Content-Encoding')]).toEqual(['1800', 'high', 'aes128gcm']);
    expect(h.get('Authorization')).toMatch(/^vapid t=/);
    expect(seen!.init.redirect).toBe('manual');
  });

  it.each([
    [404, { kind: 'gone', status: 404 }],
    [410, { kind: 'gone', status: 410 }],
    [400, { kind: 'rejected', status: 400 }],
    [401, { kind: 'rejected', status: 401 }],
    [403, { kind: 'rejected', status: 403 }],
    [413, { kind: 'bug', status: 413 }],
    [500, { kind: 'refused', status: 500 }],
    [503, { kind: 'refused', status: 503 }],
    [302, { kind: 'refused', status: 302 }],
    [200, { kind: 'refused', status: 200 }],
    [202, { kind: 'refused', status: 202 }],
    [418, { kind: 'refused', status: 418 }],
  ])('maps %i', async (status, expected) => {
    expect(await send(answer(status))).toEqual(expected);
  });

  it('reads Retry-After for a 429 in seconds or as a date, at most an hour, 10 minutes when absent or unreadable', async () => {
    expect(await send(answer(429, { 'retry-after': '120' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 120_000 });
    expect(await send(answer(429, { 'retry-after': 'Tue, 06 Oct 2026 02:05:00 GMT' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 300_000 });
    expect(await send(answer(429, { 'retry-after': '999999' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 3_600_000 });
    expect(await send(answer(429))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 600_000 });
    expect(await send(answer(429, { 'retry-after': 'soon' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 600_000 });
    expect(await send(answer(429, { 'retry-after': '0' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 0 });
    expect(await send(answer(429, { 'retry-after': '00000001' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 1_000 });
    expect(await send(answer(429, { 'retry-after': '00000000' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 0 });
    expect(await send(answer(429, { 'retry-after': '9'.repeat(400) }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 3_600_000 });
    expect(await send(answer(429, { 'retry-after': 'Tue, 06 Oct 2026 01:00:00 GMT' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 0 });
  });

  it('calls a failure before the request left "refused", and one after it may have left "uncertain"', async () => {
    const fail = (code: string) => async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    };
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']) {
      expect(await send(fail(code))).toEqual({ kind: 'refused', status: null });
    }
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'something new']) expect(await send(fail(code))).toEqual({ kind: 'uncertain', status: null });
  });

  it('calls a fetch that throws before sending a bug, never uncertain', async () => {
    const throwsAtOnce = (() => {
      throw new TypeError('invalid header');
    }) as unknown as typeof fetch;
    expect(await send(throwsAtOnce)).toEqual({ kind: 'bug', status: null });
  });

  it('aborts a send at its total deadline, as uncertain', async () => {
    const hang: typeof fetch = (_, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    expect(await send(hang, 50)).toEqual({ kind: 'uncertain', status: null });
  });

  it('calls a payload or key that cannot be encrypted a bug, without sending', async () => {
    let called = false;
    const t = webPushTransport(vapid, { fetch: async () => ((called = true), new Response(null, { status: 201 })) });
    const broken = { ...subscription(), p256dh: 'AAAA' };
    expect(await t.send(broken, '{}', { ttl: 1800, urgency: 'high' })).toEqual({ kind: 'bug', status: null });
    expect(called).toBe(false);
  });

  it('logs only a status and a category', () => {
    const text = line('warn', 'push not accepted', { push: loggable({ kind: 'gone', status: 410 }), alert: 'a1' });
    expect(JSON.parse(text)).toMatchObject({ push: { status: 410, category: 'gone' }, alert: 'a1' });
    expect(text).not.toMatch(/fcm|secret|vapid/i);
  });
});

// The default post, over node:https: it knows whether the connection (TCP and TLS) was up, so whether the request may have left.
describe('the default post', () => {
  const servers: Server[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const listen = async (srv: Server) => {
    servers.push(srv);
    srv.on('connection', (c) => (sockets.add(c), c.on('close', () => sockets.delete(c))));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return (srv.address() as AddressInfo).port;
  };
  const at = (endpoint: string, deadlineMs = 200) =>
    webPushTransport(vapid, { deadlineMs, now: () => Date.parse('2026-10-06T02:00:00Z') }).send({ ...subscription(), endpoint }, '{"v":1}', { ttl: 1800, urgency: 'high' });
  const close = async () => {
    for (const c of sockets) c.destroy();
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(r));
  };

  it('calls a send aborted before its TLS connection was up refused: nothing left', async () => {
    try {
      // Accepts TCP, never answers the TLS handshake.
      const port = await listen(createTcpServer(() => {}));
      expect(await at(`https://127.0.0.1:${port}/x`)).toEqual({ kind: 'refused', status: null });
    } finally {
      await close();
    }
  });

  it('calls a refused connection refused', async () => {
    const port = await listen(createTcpServer());
    await close();
    expect(await at(`https://127.0.0.1:${port}/x`)).toEqual({ kind: 'refused', status: null });
  });

  it('calls a send aborted after its request went out uncertain', async () => {
    try {
      const port = await listen(createHttpServer(() => {}) as unknown as Server);
      expect(await at(`http://127.0.0.1:${port}/x`)).toEqual({ kind: 'uncertain', status: null });
    } finally {
      await close();
    }
  });

  it('calls a send on a kept-alive connection that then hangs uncertain: that connection was up', async () => {
    try {
      let n = 0;
      const port = await listen(
        createHttpServer((req, res) => {
          req.resume();
          if (n++ === 0) res.writeHead(201).end();
        }) as unknown as Server,
      );
      expect(await at(`http://127.0.0.1:${port}/x`)).toEqual({ kind: 'accepted', status: 201 });
      expect(sockets.size).toBe(1);
      expect(await at(`http://127.0.0.1:${port}/x`)).toEqual({ kind: 'uncertain', status: null });
      expect(n).toBe(2);
    } finally {
      await close();
    }
  });

  it('reads the status and Retry-After, follows no redirect, and reads no body', async () => {
    try {
      let posts = 0;
      const port = await listen(
        createHttpServer((req, res) => {
          posts++;
          req.resume();
          if (req.url === '/created') res.writeHead(201).end();
          else if (req.url === '/slow') res.writeHead(429, { 'retry-after': '120' }).end('{"reason":"secret"}');
          else res.writeHead(301, { location: '/created' }).end();
        }) as unknown as Server,
      );
      expect(await at(`http://127.0.0.1:${port}/created`)).toEqual({ kind: 'accepted', status: 201 });
      expect(await at(`http://127.0.0.1:${port}/slow`)).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 120_000 });
      expect(await at(`http://127.0.0.1:${port}/moved`)).toEqual({ kind: 'refused', status: 301 });
      expect(posts).toBe(3);
    } finally {
      await close();
    }
  });

  it('settles a 101 answer (a protocol switch it never asked for) as an unexpected status, freeing its slot', async () => {
    try {
      const port = await listen(createTcpServer((c) => c.once('data', () => c.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n'))));
      expect(await at(`http://127.0.0.1:${port}/x`, 2_000)).toEqual({ kind: 'refused', status: 500 });
    } finally {
      await close();
    }
  });

  it('refuses at once, and throws nothing later, when asked to post with a signal already aborted', async () => {
    const r = nodePost('http://127.0.0.1:1/x', { method: 'POST', headers: new Headers(), body: null, redirect: 'manual', signal: AbortSignal.abort() });
    await expect(r).rejects.toMatchObject({ cause: { code: NOT_SENT } });
    await new Promise((d) => setTimeout(d, 50));
  });

  it('calls an endpoint it cannot send to (user info, another scheme) a bug, without connecting', async () => {
    expect(await at('https://user:pass@127.0.0.1:1/x')).toEqual({ kind: 'bug', status: null });
    expect(await at('ftp://127.0.0.1:1/x')).toEqual({ kind: 'bug', status: null });
  });
});

describe('send slots', () => {
  it('lets at most n sends run, and hands a freed slot to the next waiter', async () => {
    const slots = new SendSlots(2);
    const a = await slots.take();
    const b = await slots.take();
    let third = false;
    const c = slots.take().then((release) => ((third = true), release));
    await Promise.resolve();
    expect([slots.busy, third]).toEqual([2, false]);
    a();
    (await c)();
    expect(third).toBe(true);
    b();
    expect(slots.busy).toBe(0);
  });
});
