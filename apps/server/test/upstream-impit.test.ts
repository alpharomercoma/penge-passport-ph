// The real impit binary (the one CI installs, and the release ships) under the library's real client, against a
// local site and a local proxy: cookies, forms, the token, no redirects, deadlines, and proxy credentials.
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PengePassportPH } from 'penge-passport-ph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUpstreamFetch } from '../src/upstream.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/penge-passport-ph/test/fixtures/${name}`, import.meta.url), 'utf8');

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let site: Server;
let proxy: Server;
let siteUrl: string;
let proxyPort: number;
const seen: Seen[] = [];
let proxied = 0;
/** While set, the site takes requests and never answers. */
let hang = false;

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

function answerSite(req: IncomingMessage, res: ServerResponse, body: string) {
  const path = new URL(req.url!, 'http://x').pathname;
  seen.push({ method: req.method!, path, headers: req.headers, body });
  if (hang) return;
  const token = 'T1';
  const tokenOk = req.headers['__requestverificationtoken'] === token && (req.headers.cookie ?? '').includes(`__RequestVerificationToken=cookie-${token}`);
  switch (path) {
    case '/appointment':
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // Two cookies in two headers, as the site sends them.
        'set-cookie': [`__RequestVerificationToken=cookie-${token}; path=/; HttpOnly`, 'affinity=lb-7; path=/'],
      });
      return res.end(fixture('bootstrap-appointment.html').replace('FIXTURE-FORM-TOKEN', token));
    case '/sites':
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(fixture('sites-region1-country1.json'));
    case '/appointment/timeslot/available':
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(tokenOk ? fixture('availability-site486.json') : '');
    case '/countries':
      res.writeHead(301, { location: 'https://elsewhere.invalid/' });
      return res.end();
    default:
      res.writeHead(404);
      return res.end();
  }
}

beforeAll(async () => {
  site = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => answerSite(req, res, body));
  });
  const sitePort = await listen(site);
  siteUrl = `http://127.0.0.1:${sitePort}`;

  // A forward proxy that wants Basic credentials, for plain requests and for CONNECT tunnels.
  const expected = `Basic ${Buffer.from('user-1:s3cr:t').toString('base64')}`;
  proxy = createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      return res.end();
    }
    proxied++;
    const target = new URL(req.url!);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const up = httpRequest({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    });
    req.pipe(up);
  });
  proxy.on('connect', (req, socket, head) => {
    if (req.headers['proxy-authorization'] !== expected) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    proxied++;
    const [host, port] = req.url!.split(':');
    const up = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
  });
  proxyPort = await listen(proxy);
});

afterAll(() => {
  site.closeAllConnections();
  proxy.closeAllConnections();
  site.close();
  proxy.close();
});

const client = async (proxyUrl: string | null, opts: { timeoutMs?: number } = {}) =>
  new PengePassportPH({
    baseUrl: siteUrl,
    fetch: (await createUpstreamFetch({ browser: 'firefox144', proxyUrl }))!,
    stateDir: mkdtempSync(join(tmpdir(), 'pps-impit-')),
    minIntervalMs: 2000,
    contact: 'https://example.org/app',
    ...opts,
  });

describe('impit under the real client', () => {
  it('opens a session, keeps both cookies, posts the form with the token, and reads the answers', async () => {
    seen.length = 0;
    const c = await client(null);
    expect((await c.sites()).length).toBeGreaterThan(10);
    const availability = await c.availability({ siteId: 486 });
    expect(availability.earliest).toBe('2026-10-08');
    const post = seen.find((s) => s.path === '/appointment/timeslot/available')!;
    expect(post.method).toBe('POST');
    expect(post.headers['__requestverificationtoken']).toBe('T1');
    expect(post.headers.cookie).toContain('__RequestVerificationToken=cookie-T1');
    expect(post.headers.cookie).toContain('affinity=lb-7');
    expect(post.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(Object.fromEntries(new URLSearchParams(post.body))).toMatchObject({ siteId: '486', requestedSlots: '1' });
    // The package's own User-Agent, not impit's Firefox one.
    expect(post.headers['user-agent']).toMatch(/^penge-passport-ph\//);
  }, 30_000);

  it('never follows a redirect: it is a failure, and nothing reaches the other host', async () => {
    const c = await client(null);
    await expect(c.countries(1)).rejects.toThrow(/HTTP 301 \(a redirect, which is not followed\)/);
  }, 30_000);

  it("ends a request at the client's deadline", async () => {
    const c = new PengePassportPH({
      baseUrl: siteUrl,
      fetch: (await createUpstreamFetch({ browser: 'firefox144', proxyUrl: null }))!,
      stateDir: mkdtempSync(join(tmpdir(), 'pps-impit-')),
      timeoutMs: 1000,
    });
    hang = true;
    try {
      const started = Date.now();
      await expect(c.sites()).rejects.toMatchObject({ name: 'UpstreamError', status: 0, message: 'POST /sites failed: no answer within 1s' });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      hang = false;
    }
  }, 30_000);

  it('goes through a proxy with credentials', async () => {
    proxied = 0;
    const c = await client(`http://user-1:s3cr%3At@127.0.0.1:${proxyPort}`);
    expect((await c.sites()).length).toBeGreaterThan(10);
    expect(proxied).toBeGreaterThan(0);
  }, 30_000);

  it('fails on refused proxy credentials without repeating them', async () => {
    const c = await client(`http://user-1:wrong-pass@127.0.0.1:${proxyPort}`);
    const err = (await c.sites().catch((e: unknown) => e)) as Error & { status?: number };
    // To a plain-HTTP site the proxy's 407 comes back as the answer. To an https:// one (passport.gov.ph) impit
    // tunnels and throws "Proxy authentication required." instead: status 0, the site unreachable.
    expect(err).toMatchObject({ name: 'UpstreamError', status: 407, message: 'POST /sites returned HTTP 407' });
    expect(err.message).not.toContain('wrong-pass');
    expect(err.message).not.toContain('user-1');
  }, 30_000);
});
