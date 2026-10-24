import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createUpstreamFetch, describeUpstream } from '../src/upstream.ts';
import { validEnv } from './helpers.ts';

const PROXY = 'http://user-1:s3cr%3At@proxy.example:8080';
/** Webshare's shape: each exit is the account's name and a session number. */
const ROTATING = 'http://acct42-{session}:s3cr%3At@proxy.example:8080';

describe('upstream settings', () => {
  it("unset, the server asks with Node's own fetch, as before", () => {
    expect(loadConfig(validEnv).upstream).toEqual({ browsers: [], proxyUrl: null, rotations: 0 });
  });

  it('reads a browser profile, and a proxy only with one', () => {
    expect(loadConfig({ ...validEnv, UPSTREAM_BROWSER: 'firefox144' }).upstream).toEqual({ browsers: ['firefox144'], proxyUrl: null, rotations: 0 });
    expect(loadConfig({ ...validEnv, UPSTREAM_BROWSER: ' firefox144 ', UPSTREAM_PROXY_URL: ` ${PROXY} ` }).upstream).toEqual({
      browsers: ['firefox144'],
      proxyUrl: PROXY,
      rotations: 0,
    });
    for (const proxyUrl of ['https://proxy.example', 'socks5://proxy.example:1080', 'socks5://u:p@proxy.example:1080/']) {
      expect(loadConfig({ ...validEnv, UPSTREAM_BROWSER: 'firefox144', UPSTREAM_PROXY_URL: proxyUrl }).upstream.proxyUrl).toBe(proxyUrl);
    }
    // Without the fingerprint, Cloudflare challenges the proxy's address too.
    expect(() => loadConfig({ ...validEnv, UPSTREAM_PROXY_URL: PROXY })).toThrow(/UPSTREAM_PROXY_URL needs UPSTREAM_BROWSER/);
  });

  it.each([
    [{ UPSTREAM_BROWSER: 'netscape4' }, /UPSTREAM_BROWSER must be one or more/],
    [{ UPSTREAM_BROWSER: '' }, /UPSTREAM_BROWSER is set but empty/],
    [{ UPSTREAM_BROWSER: 'firefox144', UPSTREAM_PROXY_URL: ' ' }, /UPSTREAM_PROXY_URL is set but empty/],
  ])('refuses %j', (patch, error) => {
    expect(() => loadConfig({ ...validEnv, ...patch })).toThrow(error);
    expect(() => loadConfig({ ...validEnv, ...patch })).toThrow(ConfigError);
  });

  it('refuses a bad proxy URL without ever repeating it', () => {
    for (const bad of [
      'proxy.example:8080',
      'socks5h://user:hunter2@proxy.example:1080',
      'ftp://user:hunter2@proxy.example',
      'http://user:hunter2@proxy.example/some/path',
      'http://user:hunter2@proxy.example/?q=hunter2',
      'http://user:hunter2@proxy.example/#hunter2',
      'http://user:hunter2@',
    ]) {
      let err: unknown;
      try {
        loadConfig({ ...validEnv, UPSTREAM_BROWSER: 'firefox144', UPSTREAM_PROXY_URL: bad });
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/UPSTREAM_PROXY_URL must be/);
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as Error).message).not.toContain('proxy.example');
    }
  });
});

describe('describeUpstream', () => {
  it('names the profile and the proxy host, never its credentials', () => {
    expect(describeUpstream({ browsers: [], proxyUrl: null, rotations: 0 })).toBe("Node's fetch, direct");
    expect(describeUpstream({ browsers: ['firefox144'], proxyUrl: null, rotations: 0 })).toBe('impit firefox144, direct');
    expect(describeUpstream({ browsers: ['firefox144'], proxyUrl: PROXY, rotations: 0 })).toBe('impit firefox144 through proxy.example:8080');
    expect(describeUpstream({ browsers: ['firefox144'], proxyUrl: ROTATING, rotations: 3 })).toBe(
      'impit firefox144 through proxy.example:8080, a new exit each start (up to 3 more per request when refused)',
    );
    expect(describeUpstream({ browsers: ['firefox144'], proxyUrl: ROTATING, rotations: 0 })).toBe('impit firefox144 through proxy.example:8080, a new exit each start');
  });
});

/** A stand-in for impit's module: records what it was given and answers with `answer`. */
function fakeImpit(answer: (url: string, init: Record<string, unknown>) => Promise<Response>) {
  const made: unknown[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  class Impit {
    constructor(options: unknown) {
      made.push(options);
    }
    fetch(url: string, init: Record<string, unknown>) {
      calls.push([url, init]);
      return answer(url, init);
    }
  }
  return { made, calls, load: async () => ({ Impit }) as never };
}

describe('createUpstreamFetch', () => {
  it("returns nothing when no profile is set, so the client keeps Node's fetch, and never loads impit", async () => {
    const load = vi.fn();
    expect(await createUpstreamFetch({ browsers: [], proxyUrl: null, rotations: 0 }, { load })).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('makes one impit client that never follows redirects, and passes each request through as the client made it', async () => {
    const impit = fakeImpit(async () => new Response('ok', { headers: { 'set-cookie': 'a=1' } }));
    const fetch = (await createUpstreamFetch({ browsers: ['firefox144'], proxyUrl: PROXY, rotations: 0 }, { load: impit.load }))!;
    expect(impit.made).toEqual([{ browser: 'firefox144', proxyUrl: PROXY, followRedirects: false, timeout: 60_000 }]);
    const signal = new AbortController().signal;
    const headers = new Headers({ 'User-Agent': 'penge-passport-ph/x', Cookie: 'c=1' });
    const body = new URLSearchParams({ regionId: '1' });
    const res = await fetch(new URL('https://www.passport.gov.ph/sites'), { method: 'POST', headers, body, signal, redirect: 'manual' });
    expect(await res.text()).toBe('ok');
    expect(res.headers.getSetCookie()).toEqual(['a=1']);
    expect(impit.calls).toEqual([['https://www.passport.gov.ph/sites', { method: 'POST', headers, body, signal, redirect: 'manual' }]]);
  });

  it('rethrows a failure with the proxy URL, user and password taken out, and no cause', async () => {
    const leaky = Object.assign(new Error(`connect ${PROXY} failed for user-1 with s3cr:t (raw s3cr%3At) at proxy.example:8080`), {
      cause: new Error(`tunnel to ${PROXY}`),
    });
    leaky.name = 'ConnectError';
    const impit = fakeImpit(async () => {
      throw leaky;
    });
    const fetch = (await createUpstreamFetch({ browsers: ['firefox144'], proxyUrl: PROXY, rotations: 0 }, { load: impit.load }))!;
    const err = (await fetch('https://www.passport.gov.ph/appointment', {}).catch((e: unknown) => e)) as Error & { cause?: unknown };
    expect(err.name).toBe('ConnectError');
    expect(err.cause).toBeUndefined();
    for (const secret of ['s3cr:t', 's3cr%3At', 'user-1', PROXY]) expect(err.message).not.toContain(secret);
    expect(err.message).toBe('connect <proxy> failed for <proxy> with <proxy> (raw <proxy>) at proxy.example:8080');
  });

  it("keeps an abort or a timeout recognisable: the client tells them apart by name", async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const impit = fakeImpit(async () => {
        throw new DOMException('The operation was aborted', name);
      });
      const fetch = (await createUpstreamFetch({ browsers: ['firefox144'], proxyUrl: null, rotations: 0 }, { load: impit.load }))!;
      await expect(fetch('https://www.passport.gov.ph/appointment', {})).rejects.toMatchObject({ name });
    }
  });

  it('fails at start-up, not at the first request, when impit cannot load', async () => {
    const load = async () => {
      throw new Error("impit couldn't load native bindings");
    };
    await expect(createUpstreamFetch({ browsers: ['firefox144'], proxyUrl: PROXY, rotations: 0 }, { load })).rejects.toThrow(/impit could not be loaded: impit couldn't load native bindings/);
  });
});

describe('rotating settings', () => {
  const rotating = { ...validEnv, UPSTREAM_BROWSER: 'firefox144', UPSTREAM_PROXY_URL: ROTATING };

  it('takes {session} in the user name, with 3 moves per request unless told otherwise', () => {
    expect(loadConfig(rotating).upstream).toEqual({ browsers: ['firefox144'], proxyUrl: ROTATING, rotations: 3 });
    expect(loadConfig({ ...rotating, UPSTREAM_PROXY_ROTATIONS: '0' }).upstream.rotations).toBe(0);
    expect(loadConfig({ ...rotating, UPSTREAM_PROXY_ROTATIONS: '10' }).upstream.rotations).toBe(10);
  });

  it.each([
    [{ UPSTREAM_PROXY_ROTATIONS: '11' }, /UPSTREAM_PROXY_ROTATIONS must be an integer from 0 to 10/],
    [{ UPSTREAM_PROXY_ROTATIONS: '-1' }, /UPSTREAM_PROXY_ROTATIONS must be an integer from 0 to 10/],
    [{ UPSTREAM_PROXY_ROTATIONS: ' ' }, /UPSTREAM_PROXY_ROTATIONS is set but empty/],
    [{ UPSTREAM_PROXY_URL: PROXY, UPSTREAM_PROXY_ROTATIONS: '3' }, /UPSTREAM_PROXY_ROTATIONS needs \{session\}/],
    [{ UPSTREAM_PROXY_URL: 'http://acct42-{session}-{session}:hunter2@proxy.example:8080' }, /only once, in its user name/],
    [{ UPSTREAM_PROXY_URL: 'http://acct42:hunter2{session}@proxy.example:8080' }, /only once, in its user name/],
    [{ UPSTREAM_PROXY_URL: 'http://acct42:hunter2@proxy{session}.example:8080' }, /only once, in its user name/],
    [{ UPSTREAM_PROXY_URL: 'http://proxy.example:8080/{session}' }, /only once, in its user name/],
  ])('refuses %j, never repeating the value', (patch, error) => {
    let err: unknown;
    try {
      loadConfig({ ...rotating, ...patch });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(error);
    expect((err as Error).message).not.toContain('hunter2');
    expect((err as Error).message).not.toContain('proxy.example');
  });
});

/** An impit stand-in whose answer depends on the exit (the proxy URL) each instance was made with. */
function exits(answer: (proxyUrl: string, url: string, init: Record<string, unknown>) => Promise<Response>) {
  const made: string[] = [];
  const calls: { proxyUrl: string; url: string; init: Record<string, unknown> }[] = [];
  class Impit {
    readonly proxyUrl: string;
    constructor(options: { proxyUrl?: string }) {
      this.proxyUrl = options.proxyUrl ?? '';
      made.push(this.proxyUrl);
    }
    fetch(url: string, init: Record<string, unknown>) {
      calls.push({ proxyUrl: this.proxyUrl, url, init });
      return answer(this.proxyUrl, url, init);
    }
  }
  let n = 6;
  return { made, calls, load: async () => ({ Impit }) as never, pickSession: () => ++n };
}

const exitOf = (proxyUrl: string) => Number(/acct42-(\d+):/.exec(proxyUrl)?.[1]);
const challenge = () => new Response('<html>Just a moment...</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
const failure = (name: string, message: string, status?: number) => Object.assign(new Error(message), { name, ...(status !== undefined && { status }) });
const URL_ = 'https://www.passport.gov.ph/appointment/timeslot/available';

async function rotatingFetch(
  t: ReturnType<typeof exits>,
  rotations = 3,
  extra: { onRotate?: (i: unknown) => void; spacingMs?: number; now?: () => number } = {},
) {
  return (await createUpstreamFetch(
    { browsers: ['firefox144'], proxyUrl: ROTATING, rotations },
    { load: t.load, pickSession: t.pickSession, spacingMs: 0, ...extra },
  ))!;
}

describe('a new exit each start, and another when one is refused', () => {
  it('starts on its own exit: the session number in the user name', async () => {
    const t = exits(async () => new Response('[]'));
    const fetch = await rotatingFetch(t);
    await fetch(URL_, { method: 'POST' });
    expect(t.made).toEqual(['http://acct42-7:s3cr%3At@proxy.example:8080']);
  });

  it("moves on from Cloudflare's bot check and sends the same request again, intact", async () => {
    const t = exits(async (proxyUrl) => (exitOf(proxyUrl) === 7 ? challenge() : new Response('[{"IsAvailable":true}]')));
    const rotated: unknown[] = [];
    const fetch = await rotatingFetch(t, 3, { onRotate: (i) => rotated.push(i) });
    const headers = new Headers({ __RequestVerificationToken: 'T1', Cookie: 'c=1' });
    const body = new URLSearchParams({ siteId: '486' });
    const res = await fetch(URL_, { method: 'POST', headers, body });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[{"IsAvailable":true}]');
    expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 8]);
    expect(t.calls[1]!.init).toEqual(t.calls[0]!.init);
    expect(t.calls[1]!.init.body).toBe(body);
    expect(rotated).toEqual([{ reason: "POST /appointment/timeslot/available: Cloudflare's bot check", generation: 1, browser: 'firefox144' }]);
  });

  it('gives up after its n new exits and hands back the challenge; the process gets its moves back five minutes on', async () => {
    let clock = 1_000_000;
    const t = exits(async () => challenge());
    const fetch = await rotatingFetch(t, 2, { now: () => clock });
    const res = await fetch(URL_, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(res.headers.get('cf-mitigated')).toBe('challenge');
    expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 8, 9]);
    // Everyone challenged: more exits would only spread the fingerprint. The process stays put for now...
    clock += 4 * 60_000;
    expect((await fetch(URL_, { method: 'POST' })).status).toBe(403);
    expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 8, 9, 9]);
    // ...and moves again once the window has passed, so a long-lived API is never stranded on a refused exit.
    clock += 60_000;
    await fetch(URL_, { method: 'POST' });
    expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 8, 9, 9, 9, 10, 11]);
  });

  it('a move whenever it is needed, as long as the window holds fewer than n', async () => {
    let clock = 1_000_000;
    const t = exits(async (proxyUrl, url) => (url.endsWith(`/${exitOf(proxyUrl)}`) ? challenge() : new Response('ok')));
    const fetch = await rotatingFetch(t, 2, { now: () => clock });
    // Exit 7 refuses /7: one move. Three minutes on, exit 8 refuses /8: the second. Then the window is full.
    expect((await fetch('https://www.passport.gov.ph/7', {})).status).toBe(200);
    clock += 3 * 60_000;
    expect((await fetch('https://www.passport.gov.ph/8', {})).status).toBe(200);
    expect((await fetch('https://www.passport.gov.ph/9', {})).status).toBe(403);
    // Two minutes on the first move leaves the window: one more.
    clock += 2 * 60_000;
    expect((await fetch('https://www.passport.gov.ph/9', {})).status).toBe(200);
    expect(t.made.map(exitOf)).toEqual([7, 8, 9, 10]);
  });

  it('resends when the exit could not open a tunnel (5xx, or no status)', async () => {
    for (const status of [502, undefined]) {
      const t = exits(async (proxyUrl) => {
        if (exitOf(proxyUrl) === 7) throw failure('ProxyTunnelError', `Proxy rejected the CONNECT tunnel with status code ${status}.`, status);
        return new Response('ok');
      });
      const fetch = await rotatingFetch(t);
      expect(await (await fetch(URL_, { method: 'POST' })).text()).toBe('ok');
      expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 8]);
    }
  });

  it("never moves for the account's own trouble: 402 (allowance used up), 407, 400, ProxyAuthRequired", async () => {
    for (const err of [
      failure('ProxyTunnelError', 'Proxy rejected the CONNECT tunnel with status code 402.', 402),
      failure('ProxyTunnelError', 'Proxy rejected the CONNECT tunnel with status code 407.', 407),
      failure('ProxyTunnelError', 'Proxy rejected the CONNECT tunnel with status code 400.', 400),
      failure('ProxyAuthRequired', 'Proxy authentication required.'),
    ]) {
      const t = exits(async () => {
        throw err;
      });
      const fetch = await rotatingFetch(t);
      const thrown = (await fetch(URL_, { method: 'POST' }).catch((e: unknown) => e)) as Error;
      expect(thrown.name).toBe(err.name);
      expect(t.made).toHaveLength(1);
      expect(t.calls).toHaveLength(1);
    }
    const t = exits(async () => {
      throw failure('ProxyTunnelError', 'Proxy rejected the CONNECT tunnel with status code 402.', 402);
    });
    const thrown = (await (await rotatingFetch(t))(URL_, {}).catch((e: unknown) => e)) as Error;
    expect(thrown.message).toBe("Proxy rejected the CONNECT tunnel with status code 402. (the proxy's allowance is used up)");
  });

  it('after a timeout or a dropped connection: fails now (the site may have seen it), and the next request goes elsewhere', async () => {
    for (const name of ['TimeoutError', 'ReadTimeout', 'ConnectError', 'RemoteProtocolError']) {
      const t = exits(async (proxyUrl) => {
        if (exitOf(proxyUrl) === 7) throw failure(name, 'no answer');
        return new Response('ok');
      });
      const fetch = await rotatingFetch(t);
      await expect(fetch(URL_, { method: 'POST' })).rejects.toMatchObject({ name });
      expect(t.calls).toHaveLength(1);
      await fetch(URL_, { method: 'POST' });
      expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 8]);
    }
  });

  it("an answer whose body fails mid-read moves the next request, without sending this one again", async () => {
    const t = exits(async (proxyUrl) => {
      if (exitOf(proxyUrl) !== 7) return new Response('ok');
      const res = new Response('partial');
      // As impit's own body reads fail: a plain Error, its class only in the message (no rethrowNativeError there).
      Object.defineProperty(res, 'text', {
        configurable: true,
        value: async () => {
          throw new Error(`ReadError: connection to ${proxyUrl} reset`);
        },
      });
      return res;
    });
    const fetch = await rotatingFetch(t);
    const res = await fetch(URL_, { method: 'POST' });
    const err = (await res.text().catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('ReadError');
    expect(err.message).toBe('ReadError: connection to <proxy> reset');
    expect(t.calls).toHaveLength(1);
    await fetch(URL_, { method: 'POST' });
    expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 8]);
  });

  it('the same for the wording impit really uses, and not when the caller aborts the read', async () => {
    for (const [thrown, moves] of [
      [new Error('Error reading response stream: reqwest::Error { kind: Decode, source: hyper::Error(Body, IncompleteBody) }'), true],
      [new DOMException('The operation timed out', 'TimeoutError'), true],
      [new DOMException('The operation was aborted', 'AbortError'), false],
    ] as const) {
      const t = exits(async (proxyUrl) => {
        if (exitOf(proxyUrl) !== 7) return new Response('ok');
        const res = new Response('partial');
        Object.defineProperty(res, 'text', {
          configurable: true,
          value: async () => {
            throw thrown;
          },
        });
        return res;
      });
      const fetch = await rotatingFetch(t);
      await expect((await fetch(URL_, {})).text()).rejects.toMatchObject({ name: thrown.name });
      await fetch(URL_, {});
      expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual(moves ? [7, 8] : [7, 7]);
    }
  });

  it("leaves the exit alone when the caller aborts", async () => {
    const t = exits(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    const fetch = await rotatingFetch(t);
    await expect(fetch(URL_, {})).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fetch(URL_, {})).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.made).toHaveLength(1);
  });

  it('does not resend once the caller has given up', async () => {
    const controller = new AbortController();
    const t = exits(async () => {
      controller.abort();
      return challenge();
    });
    const fetch = await rotatingFetch(t);
    expect((await fetch(URL_, { signal: controller.signal })).status).toBe(403);
    expect(t.calls).toHaveLength(1);
  });

  it('moves once when two requests are refused on the same exit at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = exits(async (proxyUrl) => {
      if (exitOf(proxyUrl) !== 7) return new Response('ok');
      await gate;
      return challenge();
    });
    const fetch = await rotatingFetch(t);
    const both = Promise.all([fetch(URL_, { method: 'POST' }), fetch(URL_, { method: 'POST' })]);
    release();
    expect((await both).map((r) => r.status)).toEqual([200, 200]);
    expect(t.made.map(exitOf)).toEqual([7, 8]);
  });

  it("never sends two requests closer than the limiter's interval, though a resend was not in the limiter's plan", async () => {
    const sent: number[] = [];
    const t = exits(async (proxyUrl, url) => {
      sent.push(Date.now());
      return exitOf(proxyUrl) === 7 && url.endsWith('/first') ? challenge() : new Response('ok');
    });
    const fetch = await rotatingFetch(t, 3, { spacingMs: 200 });
    // A resend, then requests one after another (the limiter's slots come due while one is held), then two at once.
    await fetch('https://www.passport.gov.ph/first', {});
    await fetch('https://www.passport.gov.ph/second', {});
    await fetch('https://www.passport.gov.ph/third', {});
    await Promise.all([fetch('https://www.passport.gov.ph/fourth', {}), fetch('https://www.passport.gov.ph/fifth', {})]);
    expect(sent).toHaveLength(6);
    const gaps = sent.slice(1).map((at, i) => at - sent[i]!);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(190);
  });

  it('a fixed proxy is not held: its spacing is the limiter\'s alone', async () => {
    const t = exits(async () => new Response('ok'));
    const fetch = (await createUpstreamFetch({ browsers: ['firefox144'], proxyUrl: PROXY, rotations: 0 }, { load: t.load, spacingMs: 1000 }))!;
    const started = Date.now();
    await Promise.all([fetch(URL_, {}), fetch(URL_, {}), fetch(URL_, {})]);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("takes every exit's user name, the account and the password out of errors", async () => {
    const t = exits(async (proxyUrl) => {
      if (exitOf(proxyUrl) === 7) return challenge();
      throw failure('ConnectError', `via ${proxyUrl} as acct42-${exitOf(proxyUrl)} (account acct42, password s3cr:t)`);
    });
    const fetch = await rotatingFetch(t);
    const err = (await fetch(URL_, {}).catch((e: unknown) => e)) as Error;
    for (const secret of ['acct42', 's3cr:t', 's3cr%3At', 'proxy.example:8080@', ROTATING]) expect(err.message).not.toContain(secret);
    expect(err.message).toBe('via <proxy> as <proxy> (account <proxy>, password <proxy>)');
  });

  it('with 0 moves: its own exit, never another', async () => {
    let calls = 0;
    const t = exits(async () => {
      if (++calls === 2) throw failure('TimeoutError', 'no answer');
      return challenge();
    });
    const fetch = await rotatingFetch(t, 0);
    expect((await fetch(URL_, {})).status).toBe(403);
    await expect(fetch(URL_, {})).rejects.toMatchObject({ name: 'TimeoutError' });
    await fetch(URL_, {});
    expect(t.made.map(exitOf)).toEqual([7]);
    expect(t.calls.map((c) => exitOf(c.proxyUrl))).toEqual([7, 7, 7]);
  });

  it('a fixed proxy is used as before: one Impit, no resends, no moves', async () => {
    const t = exits(async () => challenge());
    const fetch = (await createUpstreamFetch({ browsers: ['firefox144'], proxyUrl: PROXY, rotations: 0 }, { load: t.load, pickSession: t.pickSession }))!;
    expect((await fetch(URL_, {})).status).toBe(403);
    await fetch(URL_, {}).catch(() => {});
    expect(t.made).toEqual([PROXY]);
    expect(t.calls).toHaveLength(2);
  });
});

describe('several profiles', () => {
  it('takes a comma-separated list, and moves need only several profiles or {session}', () => {
    const several = { ...validEnv, UPSTREAM_BROWSER: 'firefox128, chrome151', UPSTREAM_PROXY_URL: PROXY };
    expect(loadConfig(several).upstream).toEqual({ browsers: ['firefox128', 'chrome151'], proxyUrl: PROXY, rotations: 3 });
    expect(loadConfig({ ...several, UPSTREAM_PROXY_ROTATIONS: '1' }).upstream.rotations).toBe(1);
    expect(loadConfig({ ...several, UPSTREAM_PROXY_URL: ROTATING }).upstream.browsers).toEqual(['firefox128', 'chrome151']);
  });

  it.each([
    [{ UPSTREAM_BROWSER: 'firefox128,firefox128' }, /names a profile twice/],
    [{ UPSTREAM_BROWSER: 'firefox128,netscape4' }, /must be one or more/],
    [{ UPSTREAM_BROWSER: 'firefox128,' }, /must be one or more/],
  ])('refuses %j', (patch, error) => {
    expect(() => loadConfig({ ...validEnv, ...patch })).toThrow(error);
  });

  it('says so in the start-up line', () => {
    expect(describeUpstream({ browsers: ['firefox128', 'chrome151'], proxyUrl: ROTATING, rotations: 3 })).toBe(
      'impit firefox128/chrome151 (one at random each start, the next when challenged) through proxy.example:8080, a new exit each start (up to 3 more per request when refused)',
    );
    expect(describeUpstream({ browsers: ['firefox128', 'chrome151'], proxyUrl: PROXY, rotations: 3 })).toBe(
      'impit firefox128/chrome151 (one at random each start, the next when challenged) through proxy.example:8080 (up to 3 more per request when challenged)',
    );
  });

  /** Like exits(), but the stand-in also records each instance's profile. */
  function profiles(answer: (browser: string, proxyUrl: string) => Promise<Response>) {
    const made: { browser: string; proxyUrl: string }[] = [];
    const calls: { browser: string; proxyUrl: string }[] = [];
    class Impit {
      readonly browser: string;
      readonly proxyUrl: string;
      constructor(options: { browser: string; proxyUrl?: string }) {
        this.browser = options.browser;
        this.proxyUrl = options.proxyUrl ?? '';
        made.push({ browser: this.browser, proxyUrl: this.proxyUrl });
      }
      fetch() {
        calls.push({ browser: this.browser, proxyUrl: this.proxyUrl });
        return answer(this.browser, this.proxyUrl);
      }
    }
    let n = 6;
    return { made, calls, load: async () => ({ Impit }) as never, pickSession: () => ++n };
  }

  it('starts on the profile picked for it, and after a challenge moves to the next profile and a new exit', async () => {
    const t = profiles(async (browser) => (browser === 'chrome151' ? new Response('ok') : challenge()));
    const rotated: unknown[] = [];
    const fetch = (await createUpstreamFetch(
      { browsers: ['firefox144', 'firefox128', 'chrome151'], proxyUrl: ROTATING, rotations: 3 },
      { load: t.load, pickSession: t.pickSession, pickProfile: () => 1, spacingMs: 0, onRotate: (i) => rotated.push(i) },
    ))!;
    expect((await fetch(URL_, {})).status).toBe(200);
    expect(t.calls.map((c) => [c.browser, exitOf(c.proxyUrl)])).toEqual([
      ['firefox128', 7],
      ['chrome151', 8],
    ]);
    expect(rotated).toEqual([{ reason: "GET /appointment/timeslot/available: Cloudflare's bot check", generation: 1, browser: 'chrome151' }]);
  });

  it('goes round the list', async () => {
    const t = profiles(async () => challenge());
    const fetch = (await createUpstreamFetch(
      { browsers: ['firefox128', 'chrome151'], proxyUrl: ROTATING, rotations: 3 },
      { load: t.load, pickSession: t.pickSession, pickProfile: () => 1, spacingMs: 0 },
    ))!;
    expect((await fetch(URL_, {})).status).toBe(403);
    expect(t.calls.map((c) => c.browser)).toEqual(['chrome151', 'firefox128', 'chrome151', 'firefox128']);
  });

  it('a tunnel the exit could not open changes the exit only: the profile was not the trouble', async () => {
    const t = profiles(async (_browser, proxyUrl) => {
      if (exitOf(proxyUrl) === 7) throw failure('ProxyTunnelError', 'Proxy rejected the CONNECT tunnel with status code 502.', 502);
      return new Response('ok');
    });
    const fetch = (await createUpstreamFetch(
      { browsers: ['firefox128', 'chrome151'], proxyUrl: ROTATING, rotations: 3 },
      { load: t.load, pickSession: t.pickSession, pickProfile: () => 0, spacingMs: 0 },
    ))!;
    await fetch(URL_, {});
    expect(t.calls.map((c) => [c.browser, exitOf(c.proxyUrl)])).toEqual([
      ['firefox128', 7],
      ['firefox128', 8],
    ]);
  });

  it('with a fixed proxy, a challenge still moves to the next profile; a timeout has nowhere to go', async () => {
    let timeouts = 1;
    const t = profiles(async (browser) => {
      if (browser === 'firefox128') return challenge();
      if (timeouts-- > 0) throw failure('TimeoutError', 'no answer');
      return new Response('ok');
    });
    const fetch = (await createUpstreamFetch(
      { browsers: ['firefox128', 'chrome151'], proxyUrl: PROXY, rotations: 3 },
      { load: t.load, pickProfile: () => 0, spacingMs: 0 },
    ))!;
    await expect(fetch(URL_, {})).rejects.toMatchObject({ name: 'TimeoutError' });
    expect((await fetch(URL_, {})).status).toBe(200);
    expect(t.made).toEqual([
      { browser: 'firefox128', proxyUrl: PROXY },
      { browser: 'chrome151', proxyUrl: PROXY },
    ]);
    expect(t.calls.map((c) => c.browser)).toEqual(['firefox128', 'chrome151', 'chrome151']);
  });
});
