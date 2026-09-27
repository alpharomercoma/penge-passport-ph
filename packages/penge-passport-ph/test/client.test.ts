import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PengePassportPH, type PengePassportPHOptions } from '../src/client.js';
import { SessionError, UpstreamError } from '../src/errors.js';
import { VERSION } from '../src/meta.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

interface Call {
  method: string;
  path: string;
  headers: Headers;
  form: URLSearchParams;
  at: number;
}

/**
 * A stand-in for passport.gov.ph. `/appointment` hands out token "T<n>" with
 * a matching cookie; token-protected endpoints answer an empty 200 when the
 * header and cookie don't match, as the real site does.
 */
function fakeSite(overrides: Partial<Record<string, (call: Call) => Response>> = {}) {
  const calls: Call[] = [];
  let issued = 0;
  let validToken: string | null = null;
  const bootstrapHtml = fixture('bootstrap-appointment.html');

  const handler = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers: new Headers(init?.headers),
      form: new URLSearchParams(init?.body ? String(init.body) : ''),
      at: Date.now(),
    };
    calls.push(call);
    const override = overrides[call.path];
    if (override) return override(call);

    const tokenOk =
      validToken !== null &&
      call.headers.get('__RequestVerificationToken') === validToken &&
      (call.headers.get('Cookie') ?? '').includes(`__RequestVerificationToken=cookie-${validToken}`);

    switch (call.path) {
      case '/appointment': {
        validToken = `T${++issued}`;
        return new Response(bootstrapHtml.replace('FIXTURE-FORM-TOKEN', validToken), {
          headers: {
            'content-type': 'text/html',
            'set-cookie': `__RequestVerificationToken=cookie-${validToken}; path=/; HttpOnly`,
          },
        });
      }
      case '/countries':
        return json(fixture('countries-region1.json'));
      case '/sites':
        return json(fixture('sites-region1-country1.json'));
      case '/appointment/timeslot/available':
        return tokenOk ? json(fixture('availability-site486.json')) : new Response('');
      case '/appointment/timeslot':
        return tokenOk ? html(fixture('timeslot-2026-10-05-site486.html')) : new Response('');
      default:
        return new Response('not found', { status: 404 });
    }
  };
  return {
    calls,
    fetch: vi.fn(handler) as unknown as typeof fetch,
    expireToken: () => {
      validToken = 'expired';
    },
  };
}

const json = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } });
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });

let hostCounter = 0;
/** Each client gets its own host so tests don't share a process-wide gate. */
function client(site: ReturnType<typeof fakeSite>, opts: PengePassportPHOptions = {}) {
  return new PengePassportPH({
    baseUrl: `https://test-${++hostCounter}.invalid`,
    fetch: site.fetch,
    stateDir: freshStateDir(),
    ...opts,
  });
}

/** Rate-limiter state lives on disk; give every test its own. */
const freshStateDir = () => mkdtempSync(join(tmpdir(), 'pps-test-'));

/** Run a promise to completion while advancing fake time. */
async function settle<T>(p: Promise<T>, ms = 120_000): Promise<T> {
  const guarded = p.then(
    (v) => ({ v }),
    (e: unknown) => ({ e }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const r = await guarded;
  if ('e' in r) throw r.e;
  return r.v;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-26T05:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PengePassportPH', () => {
  it('bootstraps a session, then asks for availability with the token', async () => {
    const site = fakeSite();
    const c = client(site);
    const result = await settle(c.availability({ siteId: 486 }));

    expect(site.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /appointment',
      'POST /appointment/timeslot/available',
    ]);
    const post = site.calls[1]!;
    expect(Object.fromEntries(post.form)).toEqual({
      fromDate: '2026-09-26',
      toDate: '2027-03-31',
      siteId: '486',
      requestedSlots: '1',
    });
    expect(post.headers.get('__RequestVerificationToken')).toBe('T1');
    expect(post.headers.get('User-Agent')).toBe(
      `penge-passport-ph/${VERSION} (+https://alphaexperiments.com/pengepassportph/; read-only availability checker)`,
    );
    expect(post.at - site.calls[0]!.at).toBeGreaterThanOrEqual(3000);

    expect(result).toMatchObject({
      siteId: 486,
      from: '2026-09-26',
      to: '2027-03-31',
      applicants: 1,
      earliest: '2026-10-08',
      cached: false,
    });
    expect(result.availableDates).not.toContain('2026-10-05');
    expect(result.days).toHaveLength(23);
  });

  it('serves repeats from cache and de-duplicates concurrent calls', async () => {
    const site = fakeSite();
    const c = client(site);
    const [a, b] = await settle(
      Promise.all([c.availability({ siteId: 486 }), c.availability({ siteId: 486 })]),
      10_000,
    );
    expect(a.earliest).toBe(b.earliest);
    const again = await settle(c.availability({ siteId: 486 }), 10_000);
    expect(again.cached).toBe(true);
    expect(site.calls.filter((x) => x.path === '/appointment/timeslot/available')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(61_000);
    const fresh = await settle(c.availability({ siteId: 486 }));
    expect(fresh.cached).toBe(false);
    expect(site.calls.filter((x) => x.path === '/appointment/timeslot/available')).toHaveLength(2);
  });

  it('re-bootstraps once when the token is rejected (empty 200)', async () => {
    const site = fakeSite();
    const c = client(site);
    await settle(c.availability({ siteId: 486 }));
    site.expireToken();
    await settle(c.availability({ siteId: 486, applicants: 2 }));
    expect(site.calls.map((x) => x.path)).toEqual([
      '/appointment',
      '/appointment/timeslot/available',
      '/appointment/timeslot/available',
      '/appointment',
      '/appointment/timeslot/available',
    ]);
  });

  it('throws SessionError when a new session is rejected too', async () => {
    const site = fakeSite({ '/appointment/timeslot/available': () => new Response('') });
    const c = client(site);
    await expect(settle(c.availability({ siteId: 486 }))).rejects.toBeInstanceOf(SessionError);
    expect(site.calls.filter((x) => x.path === '/appointment')).toHaveLength(2);
  });

  it('fails loudly when the bootstrap page has no token', async () => {
    const site = fakeSite({ '/appointment': () => html('<h1>Under maintenance</h1>') });
    await expect(settle(client(site).availability({ siteId: 486 }))).rejects.toThrow(
      /No anti-forgery token/,
    );
  });

  it('fails loudly on non-JSON availability', async () => {
    const site = fakeSite({
      '/appointment/timeslot/available': () => html('<html>Request Rejected</html>'),
    });
    await expect(settle(client(site).availability({ siteId: 486 }))).rejects.toThrow(
      /did not return JSON/,
    );
  });

  it('backs off after HTTP 503 and exposes the status', async () => {
    const site = fakeSite({
      '/sites': () => new Response('busy', { status: 503, headers: { 'retry-after': '120' } }),
    });
    const c = client(site);
    const err = await settle(c.sites(), 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(503);
    expect(await c.stats()).toMatchObject({ consecutiveFailures: 1 });
    // The next call is further away than maxWaitMs, so it is refused, not queued.
    await expect(c.sites({ regionId: 2 })).rejects.toMatchObject({ name: 'RateLimitError' });
    expect(site.calls).toHaveLength(1);
  });

  it('hands out copies, so a caller changing a result cannot change the cache', async () => {
    const site = fakeSite();
    const c = client(site);
    const first = await settle(c.availability({ siteId: 486 }), 10_000);
    const earliest = first.earliest;
    first.availableDates.length = 0;
    first.days[0]!.available = !first.days[0]!.available;
    const again = await settle(c.availability({ siteId: 486 }), 10_000);
    expect(again.cached).toBe(true);
    expect(again.earliest).toBe(earliest);
    expect(again.availableDates.length).toBeGreaterThan(0);
    expect(again.days[0]!.available).toBe(!first.days[0]!.available);
    const sites = await settle(c.sites());
    sites[0]!.name = 'changed';
    sites.pop();
    expect((await settle(c.sites())).map((s) => s.name)).not.toContain('changed');
    expect(await settle(c.sites())).toHaveLength(sites.length + 1);
  });

  it('lists and searches sites, caching the directory', async () => {
    const site = fakeSite();
    const c = client(site);
    const found = await settle(c.findSites('antipolo'));
    expect(found.map((s) => s.id)).toEqual([486]);
    await settle(c.findSites('angeles'));
    expect(site.calls.filter((x) => x.path === '/sites')).toHaveLength(1);
    expect(Object.fromEntries(site.calls[0]!.form)).toEqual({ regionId: '1', countryId: '1' });
  });

  it('reads time slots for a date', async () => {
    const site = fakeSite();
    const slots = await settle(client(site).timeSlots({ siteId: 486, date: '2026-10-05' }));
    expect(slots.filter((s) => s.available)).toEqual([
      expect.objectContaining({ start: '08:30', end: '09:30', remaining: 1 }),
    ]);
    expect(Object.fromEntries(site.calls[1]!.form)).toEqual({
      preferredDate: '2026-10-05',
      siteId: '486',
      requiredSlots: '1',
    });
  });

  it('validates input before touching the network', async () => {
    const site = fakeSite();
    const c = client(site);
    await expect(c.availability({ siteId: 0 })).rejects.toThrow(RangeError);
    await expect(c.availability({ siteId: 486, applicants: 1.5 })).rejects.toThrow(RangeError);
    // The DFA's group form stops at 5.
    await expect(c.availability({ siteId: 486, applicants: 6 })).rejects.toThrow('applicants must be 1 to 5');
    await expect(c.timeSlots({ siteId: 486, date: '2026-10-01', applicants: 6 })).rejects.toThrow(RangeError);
    await expect(c.timeSlots({ siteId: 486, date: '2026-13-01' })).rejects.toThrow(RangeError);
    expect(site.calls).toHaveLength(0);
  });

  it('refuses limits faster than the hard floor', () => {
    const site = fakeSite();
    expect(() => client(site, { minIntervalMs: 500 })).toThrow(RangeError);
    expect(() => client(site, { maxRequestsPerHour: 10_000 })).toThrow(RangeError);
    expect(() => client(site, { availabilityTtlMs: 1000 })).toThrow(RangeError);
  });

  it('shares one rate limit across clients on the same host', async () => {
    const site = fakeSite();
    const baseUrl = 'https://shared-host.invalid';
    const stateDir = freshStateDir();
    const a = new PengePassportPH({ baseUrl, fetch: site.fetch, stateDir });
    const b = new PengePassportPH({ baseUrl, fetch: site.fetch, stateDir });
    await settle(Promise.all([a.sites(), b.countries(1)]));
    const [first, second] = site.calls;
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(3000);
  });
});

describe('failure accounting and cancellation', () => {
  it('counts a 404 and an unreadable 200 as failures, so they back off', async () => {
    const site = fakeSite({
      '/countries': () => new Response('gone', { status: 404 }),
      '/sites': () => html('<html>Request Rejected</html>'),
    });
    const c = client(site, { maxWaitMs: 10 * 60_000 });
    await expect(settle(c.countries(1), 1000)).rejects.toMatchObject({ status: 404 });
    expect((await c.stats()).consecutiveFailures).toBe(1);
    await expect(settle(c.sites(), 30_000)).rejects.toThrow(/did not return JSON/);
    expect((await c.stats()).consecutiveFailures).toBe(2);
    // The second request waited out the 5 s backoff, not just the 3 s gap.
    expect(site.calls[1]!.at - site.calls[0]!.at).toBeGreaterThanOrEqual(5000);
  });

  it('reports an unreachable site as an UpstreamError and backs off', async () => {
    const site = fakeSite({
      '/sites': () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND') });
      },
    });
    const c = client(site);
    await expect(settle(c.sites(), 1000)).rejects.toMatchObject({
      name: 'UpstreamError',
      status: 0,
      message: 'POST /sites failed: getaddrinfo ENOTFOUND',
    });
    expect((await c.stats()).consecutiveFailures).toBe(1);
  });

  it('penalises a session the server keeps rejecting', async () => {
    const site = fakeSite({ '/appointment/timeslot/available': () => new Response('') });
    const c = client(site);
    await expect(settle(c.availability({ siteId: 486 }))).rejects.toBeInstanceOf(SessionError);
    expect((await c.stats()).consecutiveFailures).toBe(1);
  });

  it('starts nothing for a caller who has already given up', async () => {
    const site = fakeSite();
    const c = client(site);
    const gaveUp = AbortSignal.abort();
    await expect(c.availability({ siteId: 486, signal: gaveUp })).rejects.toBe(gaveUp.reason);
    await expect(c.timeSlots({ siteId: 486, date: '2026-10-05', signal: gaveUp })).rejects.toBe(gaveUp.reason);
    expect(site.calls).toHaveLength(0);
  });

  it('lets one caller abort without failing another that shares the request', async () => {
    const site = fakeSite();
    const c = client(site);
    const a = new AbortController();
    const first = c.availability({ siteId: 486, signal: a.signal });
    const second = c.availability({ siteId: 486 });
    first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    a.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const result = await settle(second);
    expect(result.earliest).toBe('2026-10-08');
    expect(site.calls.filter((x) => x.path === '/appointment/timeslot/available')).toHaveLength(1);
  });

  it('cancels a queued request once every caller has aborted', async () => {
    const site = fakeSite();
    const c = client(site);
    await settle(c.sites(), 1000); // occupy the gate so the next call has to queue
    const a = new AbortController();
    const pending = c.countries(1, { signal: a.signal });
    pending.catch(() => undefined);
    a.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(site.calls.map((x) => x.path)).toEqual(['/sites']);
    expect((await c.stats()).consecutiveFailures).toBe(0);
  });

  it('rejects bad dates before touching the network', async () => {
    const site = fakeSite();
    await expect(client(site).availability({ siteId: 486, from: '2026-02-30' })).rejects.toThrow(RangeError);
    expect(site.calls).toHaveLength(0);
  });
});

describe('input and transport hardening', () => {
  it('does not follow redirects: a 3xx is a failure, not a second request', async () => {
    const seen: RequestInit[] = [];
    const site = fakeSite({
      '/sites': () => new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
    });
    const spy = (async (url: string, init: RequestInit) => {
      seen.push(init);
      return site.fetch(url, init);
    }) as unknown as typeof fetch;
    const c = client(site, { fetch: spy });
    await expect(settle(c.sites(), 1000)).rejects.toThrow(/HTTP 302 \(a redirect, which is not followed\)/);
    expect(seen[0]!.redirect).toBe('manual');
    expect((await c.stats()).consecutiveFailures).toBe(1);
  });

  it('rejects a contact that would break the User-Agent', () => {
    for (const contact of ['a\r\nX-Injected: 1', 'emoji \u{1F600}', 'a(b)', '', 'x'.repeat(201)]) {
      expect(() => client(fakeSite(), { contact })).toThrow(RangeError);
    }
    expect(() => client(fakeSite(), { contact: 'me@example.com' })).not.toThrow();
  });

  it('rejects a maxWaitMs that is NaN or negative', () => {
    for (const maxWaitMs of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      expect(() => client(fakeSite(), { maxWaitMs })).toThrow(RangeError);
    }
    expect(() => client(fakeSite(), { maxWaitMs: 0 })).not.toThrow();
    expect(() => client(fakeSite(), { maxWaitMs: Number.POSITIVE_INFINITY })).not.toThrow();
  });
});

describe('watch', () => {
  it('reports the first result, then only what changed', async () => {
    let round = 0;
    const days = JSON.parse(fixture('availability-site486.json')) as {
      IsAvailable: boolean;
      AppointmentDate: number;
    }[];
    const site = fakeSite({
      '/appointment/timeslot/available': () => {
        round++;
        // Round 2: 2026-10-05 opens up and 2026-10-08 fills.
        const body = days.map((d) => {
          const date = new Date(d.AppointmentDate).toISOString().slice(0, 10);
          if (round >= 2 && date === '2026-10-05') return { ...d, IsAvailable: true };
          if (round >= 2 && date === '2026-10-08') return { ...d, IsAvailable: false };
          return d;
        });
        return json(JSON.stringify(body));
      },
    });
    const c = client(site);
    const controller = new AbortController();
    const events: unknown[] = [];
    const done = (async () => {
      for await (const e of c.watch({ siteIds: [486], intervalMs: 60_000, signal: controller.signal })) {
        events.push(e);
        if (events.length === 2) controller.abort();
      }
    })();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await done;

    expect(events[0]).toMatchObject({ type: 'availability', initial: true, siteId: 486 });
    expect(events[1]).toMatchObject({
      type: 'availability',
      initial: false,
      opened: ['2026-10-05'],
      closed: ['2026-10-08'],
    });
  });

  it('refuses a watch that would exceed the hourly budget', async () => {
    const c = client(fakeSite());
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const iterator = c.watch({ siteIds: ids, intervalMs: 60_000 });
    await expect(iterator.next()).rejects.toThrow(/over the budget/);
    await expect(c.watch({ siteIds: [1], intervalMs: 5000 }).next()).rejects.toThrow(RangeError);
  });

  it('charges session refreshes at their real cadence', async () => {
    // 5 sites every 65 s is ~277 requests/hour plus one refresh: inside 300.
    const c = client(fakeSite());
    const controller = new AbortController();
    const it = c.watch({ siteIds: [1, 2, 3, 4, 5], intervalMs: 65_000, signal: controller.signal });
    const first = it.next();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toBeDefined();
  });
});
