import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createUpstreamFetch, describeUpstream } from '../src/upstream.ts';
import { validEnv } from './helpers.ts';

const PROXY = 'http://user-1:s3cr%3At@proxy.example:8080';

describe('upstream settings', () => {
  it("unset, the server asks with Node's own fetch, as before", () => {
    expect(loadConfig(validEnv).upstream).toEqual({ browser: null, proxyUrl: null });
  });

  it('reads a browser profile, and a proxy only with one', () => {
    expect(loadConfig({ ...validEnv, UPSTREAM_BROWSER: 'firefox144' }).upstream).toEqual({ browser: 'firefox144', proxyUrl: null });
    expect(loadConfig({ ...validEnv, UPSTREAM_BROWSER: ' firefox144 ', UPSTREAM_PROXY_URL: ` ${PROXY} ` }).upstream).toEqual({
      browser: 'firefox144',
      proxyUrl: PROXY,
    });
    for (const proxyUrl of ['https://proxy.example', 'socks5://proxy.example:1080', 'socks5://u:p@proxy.example:1080/']) {
      expect(loadConfig({ ...validEnv, UPSTREAM_BROWSER: 'firefox144', UPSTREAM_PROXY_URL: proxyUrl }).upstream.proxyUrl).toBe(proxyUrl);
    }
    // Without the fingerprint, Cloudflare challenges the proxy's address too.
    expect(() => loadConfig({ ...validEnv, UPSTREAM_PROXY_URL: PROXY })).toThrow(/UPSTREAM_PROXY_URL needs UPSTREAM_BROWSER/);
  });

  it.each([
    [{ UPSTREAM_BROWSER: 'netscape4' }, /UPSTREAM_BROWSER must be one of/],
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
    expect(describeUpstream({ browser: null, proxyUrl: null })).toBe("Node's fetch, direct");
    expect(describeUpstream({ browser: 'firefox144', proxyUrl: null })).toBe('impit firefox144, direct');
    expect(describeUpstream({ browser: 'firefox144', proxyUrl: PROXY })).toBe('impit firefox144 through proxy.example:8080');
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
    expect(await createUpstreamFetch({ browser: null, proxyUrl: null }, load)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('makes one impit client that never follows redirects, and passes each request through as the client made it', async () => {
    const impit = fakeImpit(async () => new Response('ok', { headers: { 'set-cookie': 'a=1' } }));
    const fetch = (await createUpstreamFetch({ browser: 'firefox144', proxyUrl: PROXY }, impit.load))!;
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
    const fetch = (await createUpstreamFetch({ browser: 'firefox144', proxyUrl: PROXY }, impit.load))!;
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
      const fetch = (await createUpstreamFetch({ browser: 'firefox144', proxyUrl: null }, impit.load))!;
      await expect(fetch('https://www.passport.gov.ph/appointment', {})).rejects.toMatchObject({ name });
    }
  });

  it('fails at start-up, not at the first request, when impit cannot load', async () => {
    const load = async () => {
      throw new Error("impit couldn't load native bindings");
    };
    await expect(createUpstreamFetch({ browser: 'firefox144', proxyUrl: PROXY }, load)).rejects.toThrow(/impit could not be loaded: impit couldn't load native bindings/);
  });
});
