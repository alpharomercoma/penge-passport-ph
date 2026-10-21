// How this server reaches passport.gov.ph. Since October 2026 the site sits behind Cloudflare's bot check, which
// refuses Node's own fetch from any address and every request from this server's (a datacenter's). What gets
// through is impit, a Rust HTTP client that looks like a browser on the wire, through a residential proxy
// (docs/superpowers/specs/2026-10-21-upstream-route-design.md). Unset, the clients keep Node's fetch.
import type { Browser } from 'impit';

/** impit's browser profiles. `firefox144` is the one Cloudflare let through when this was written. */
export const UPSTREAM_BROWSERS = [
  'chrome',
  'chrome100',
  'chrome101',
  'chrome104',
  'chrome107',
  'chrome110',
  'chrome116',
  'chrome124',
  'chrome125',
  'chrome131',
  'chrome136',
  'chrome142',
  'chrome151',
  'firefox',
  'firefox128',
  'firefox133',
  'firefox135',
  'firefox144',
  'okhttp',
  'okhttp3',
  'okhttp4',
  'okhttp5',
  'ios18',
] as const satisfies readonly Browser[];

export type UpstreamBrowser = (typeof UPSTREAM_BROWSERS)[number];

export interface UpstreamConfig {
  /** UPSTREAM_BROWSER: null keeps Node's fetch. */
  browser: UpstreamBrowser | null;
  /** UPSTREAM_PROXY_URL, credentials included: never log it. Only with a browser profile. */
  proxyUrl: string | null;
}

/** A backstop only: the client ends each request at its own deadline (20 s) through the signal. */
const IMPIT_TIMEOUT_MS = 60_000;

type ImpitModule = Pick<typeof import('impit'), 'Impit'>;

/** For the start-up log line: the profile and the proxy's host, never its credentials. */
export function describeUpstream(config: UpstreamConfig): string {
  if (!config.browser) return "Node's fetch, direct";
  return config.proxyUrl ? `impit ${config.browser} through ${new URL(config.proxyUrl).host}` : `impit ${config.browser}, direct`;
}

/**
 * One fetch for the process, for every PengePassportPH it makes; undefined keeps Node's. impit is loaded here, at
 * start-up, so a release whose native binary cannot load fails at once (the API then fails its ready check and
 * penge-activate rolls it back), not quietly at the first request.
 */
export async function createUpstreamFetch(
  config: UpstreamConfig,
  load: () => Promise<ImpitModule> = () => import('impit'),
): Promise<typeof fetch | undefined> {
  if (!config.browser) return undefined;
  let mod: ImpitModule;
  try {
    mod = await load();
  } catch (err) {
    throw new Error(`impit could not be loaded: ${(err as Error).message.trim().split('\n')[0]}`);
  }
  const impit = new mod.Impit({
    browser: config.browser,
    ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
    followRedirects: false,
    timeout: IMPIT_TIMEOUT_MS,
  });
  const scrub = secretsOf(config.proxyUrl);
  const upstreamFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    try {
      // The client sends exactly these; impit takes the same shapes (Headers, URLSearchParams, AbortSignal).
      return (await impit.fetch(String(input instanceof Request ? input.url : input), {
        ...(init.method !== undefined && { method: init.method as 'GET' | 'POST' }),
        ...(init.headers !== undefined && { headers: init.headers as Headers }),
        ...(init.body !== undefined && init.body !== null && { body: init.body as URLSearchParams }),
        ...(init.signal !== undefined && init.signal !== null && { signal: init.signal }),
        ...(init.redirect !== undefined && { redirect: init.redirect }),
      })) as unknown as Response;
    } catch (err) {
      // An error reaches the logs and the stored scan as "<METHOD> <path> failed: <message>": no credentials in it,
      // and no cause, which the client would read instead.
      const e = err as Error;
      const clean = new Error(scrub(String(e?.message ?? err)));
      clean.name = typeof e?.name === 'string' ? e.name : 'Error';
      throw clean;
    }
  };
  return upstreamFetch as typeof fetch;
}

/** Replaces the proxy URL, its user name and its password (as written and decoded) wherever they appear. */
function secretsOf(proxyUrl: string | null): (text: string) => string {
  if (!proxyUrl) return (text) => text;
  const url = new URL(proxyUrl);
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const secrets = [proxyUrl, proxyUrl.replace(/\/$/, ''), url.href, url.password, decode(url.password), url.username, decode(url.username)]
    .filter((s) => s.length > 0)
    // Longest first, so a password inside the URL goes with the URL.
    .sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((out, s) => out.split(s).join('<proxy>'), text);
}
