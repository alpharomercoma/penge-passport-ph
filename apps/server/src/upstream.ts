// How this server reaches passport.gov.ph. Since October 2026 the site sits behind Cloudflare's bot check, which
// refuses Node's own fetch from any address and every request from this server's (a datacenter's). What gets
// through is impit, a Rust HTTP client that looks like a browser on the wire, through a residential proxy
// (docs/superpowers/specs/2026-10-21-upstream-route-design.md). Unset, the clients keep Node's fetch.
//
// With `{session}` in the proxy's user name, each process takes its own exit (a random session number), and moves
// to another when one is refused (docs/superpowers/specs/2026-10-24-proxy-rotation-design.md).
import { randomInt } from 'node:crypto';
import type { Browser } from 'impit';
import { LIMITS } from 'penge-passport-ph';

/**
 * impit's browser profiles. Which ones Cloudflare lets through changes: on 21 Oct 2026 firefox144 passed and the
 * Chrome ones were challenged; on 24 Oct firefox144 was challenged on every exit tried, and on one exit firefox135
 * was too while firefox133, firefox128, chrome142 and chrome151 passed (deploy/README.md, "Reaching passport.gov.ph").
 */
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

/** Written once in UPSTREAM_PROXY_URL's user name; each exit puts its own number there. */
export const SESSION_PLACEHOLDER = '{session}';

export interface UpstreamConfig {
  /** UPSTREAM_BROWSER: null keeps Node's fetch. */
  browser: UpstreamBrowser | null;
  /** UPSTREAM_PROXY_URL, credentials included: never log it. Only with a browser profile. */
  proxyUrl: string | null;
  /** UPSTREAM_PROXY_ROTATIONS: new exits one request may take, each with a resend, when refused. 0 without `{session}`. */
  rotations: number;
}

/** A backstop only: the client ends each request at its own deadline (20 s) through the signal. */
const IMPIT_TIMEOUT_MS = 60_000;
/**
 * A process takes at most `rotations` new exits in this long. When Cloudflare challenges everyone (24 of 24 exits
 * on 24 October, 02:08Z), more exits only spread one fingerprint across more addresses, which looks worse. One
 * checker period: a run tries at most rotations + 1 exits, and the API gets its moves back five minutes on.
 */
const ROTATION_WINDOW_MS = 5 * 60_000;
/** Session numbers Webshare took when this was written (any number tried, up to 200000). */
const SESSION_MAX = 1_000_000;

type ImpitModule = Pick<typeof import('impit'), 'Impit'>;

export interface UpstreamOptions {
  load?: () => Promise<ImpitModule>;
  /** A session number for a new exit: random, unless a test says otherwise. */
  pickSession?: () => number;
  /** Told of every move to a new exit; `reason` never holds the proxy's URL. */
  onRotate?: (info: { reason: string; generation: number }) => void;
  /** The clients' interval between requests (the library's default): what a resend must leave before the next. */
  spacingMs?: number;
  /** For tests: the clock the window of moves is kept by. */
  now?: () => number;
}

export const rotatesExits = (proxyUrl: string | null) => proxyUrl?.includes(SESSION_PLACEHOLDER) ?? false;

/** For the start-up log line: the profile and the proxy's host, never its credentials. */
export function describeUpstream(config: UpstreamConfig): string {
  if (!config.browser) return "Node's fetch, direct";
  if (!config.proxyUrl) return `impit ${config.browser}, direct`;
  const via = `impit ${config.browser} through ${new URL(config.proxyUrl.replace(SESSION_PLACEHOLDER, '1')).host}`;
  if (!rotatesExits(config.proxyUrl)) return via;
  return config.rotations > 0
    ? `${via}, a new exit each start (up to ${config.rotations} more per request when refused)`
    : `${via}, a new exit each start`;
}

/**
 * What a failure says about the exit it went out on. `resend`: the request never reached passport.gov.ph (the exit
 * could not open a tunnel), so it may go again on another exit. `move`: the exit may be at fault, but the site may
 * have seen the request, so it is not sent again; the next one goes out elsewhere. `none`: not the exit's doing
 * (the caller's own abort; the proxy refusing the account: 402 allowance used up, 407, other 4xx).
 */
function judge(err: unknown): 'resend' | 'move' | 'none' {
  const status = (err as { status?: unknown } | null)?.status;
  switch (nameOf(err)) {
    case 'ProxyTunnelError':
      return typeof status !== 'number' || status >= 500 ? 'resend' : 'none';
    case 'TimeoutError':
    case 'ConnectTimeout':
    case 'ReadTimeout':
    case 'WriteTimeout':
    case 'PoolTimeout':
    case 'NetworkError':
    case 'ConnectError':
    case 'ReadError':
    case 'WriteError':
    case 'CloseError':
    case 'RemoteProtocolError':
    case 'ProxyError':
      return 'move';
    default:
      return 'none';
  }
}

/**
 * impit names its errors in fetch() only: a body read that fails rejects with a plain Error, at most with the class's
 * name at the start of its message ("ReadError: …", as impit's own rethrowNativeError reads it).
 */
function nameOf(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  if (name !== 'Error') return name;
  return (typeof e?.message === 'string' && /^(\w+): /.exec(e.message)?.[1]) || name;
}

/**
 * One fetch for the process, for every PengePassportPH it makes; undefined keeps Node's. impit is loaded here, at
 * start-up, so a release whose native binary cannot load fails at once (the API then fails its ready check and
 * penge-activate rolls it back), not quietly at the first request.
 */
export async function createUpstreamFetch(config: UpstreamConfig, options: UpstreamOptions = {}): Promise<typeof fetch | undefined> {
  if (!config.browser) return undefined;
  const {
    load = () => import('impit'),
    pickSession = () => randomInt(1, SESSION_MAX),
    onRotate,
    spacingMs = LIMITS.defaultMinIntervalMs,
    now = Date.now,
  } = options;
  let mod: ImpitModule;
  try {
    mod = await load();
  } catch (err) {
    throw new Error(`impit could not be loaded: ${(err as Error).message.trim().split('\n')[0]}`);
  }
  const browser = config.browser;
  const template = config.proxyUrl;
  const rotating = rotatesExits(template);
  const rotations = rotating ? config.rotations : 0;

  let session = rotating ? pickSession() : 0;
  const proxyFor = (n: number) => (rotating ? template!.replace(SESSION_PLACEHOLDER, String(n)) : template);
  const make = (proxyUrl: string | null) =>
    new mod.Impit({ browser, ...(proxyUrl ? { proxyUrl } : {}), followRedirects: false, timeout: IMPIT_TIMEOUT_MS });
  let proxyUrl = proxyFor(session);
  let impit = make(proxyUrl);
  /** Bumped on every move, so failures on an exit already left behind do not move again. */
  let generation = 0;
  /**
   * When moving is on, no two sends go out closer than spacingMs. The limiter spaced each request's first attempt,
   * not a resend, and a request held for a resend's sake would otherwise crowd the one after it. Sends queue one
   * behind another and each waits from when the one before actually went out, so a late timer only adds room.
   */
  let lastSend = -Infinity;
  let queue: Promise<void> = Promise.resolve();
  const takeSlot = async (signal: AbortSignal | null | undefined) => {
    if (rotations === 0) return;
    const before = queue;
    let release!: () => void;
    queue = new Promise((resolve) => (release = resolve));
    await before;
    try {
      const wait = lastSend + spacingMs - Date.now();
      if (wait > 0) await sleep(wait, signal);
      lastSend = Date.now();
    } finally {
      release();
    }
  };

  /** When this process last moved: no more than `rotations` of them within ROTATION_WINDOW_MS. */
  const moves: number[] = [];

  /**
   * Moves to a new exit, unless the exit `from` is already behind us. False when moving is off (fixed, or 0), or
   * when this process has used its moves for now.
   */
  const rotate = (from: number, reason: string): boolean => {
    if (rotations === 0) return false;
    if (from !== generation) return true;
    while (moves.length > 0 && now() - moves[0]! >= ROTATION_WINDOW_MS) moves.shift();
    if (moves.length >= rotations) return false;
    moves.push(now());
    let next = pickSession();
    for (let i = 0; next === session && i < 5; i++) next = pickSession();
    generation++;
    session = next;
    proxyUrl = proxyFor(session);
    impit = make(proxyUrl);
    onRotate?.({ reason, generation });
    return true;
  };

  const scrub = secretsOf(template);
  const upstreamFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    // The client sends exactly these; impit takes the same shapes (Headers, URLSearchParams, AbortSignal).
    const request = {
      ...(init.method !== undefined && { method: init.method as 'GET' | 'POST' }),
      ...(init.headers !== undefined && { headers: init.headers as Headers }),
      ...(init.body !== undefined && init.body !== null && { body: init.body as URLSearchParams }),
      ...(init.signal !== undefined && init.signal !== null && { signal: init.signal }),
      ...(init.redirect !== undefined && { redirect: init.redirect }),
    };
    const what = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    const why = (err: unknown) => {
      const status = (err as { status?: unknown } | null)?.status;
      return `${what}: ${nameOf(err)}${typeof status === 'number' ? ` ${status}` : ''}`;
    };
    // At most `rotations` resends, each on a new exit, and the process's own moves run out within the window first
    // when every exit is refused; they come back as the window passes, so a burst never strands the API.
    for (let attempt = 0; ; attempt++) {
      await takeSlot(init.signal);
      const from = generation;
      const via = proxyUrl;
      let res: Response;
      try {
        res = (await impit.fetch(url, request)) as unknown as Response;
      } catch (err) {
        const verdict = judge(err);
        const moved = verdict !== 'none' && rotate(from, why(err));
        if (moved && verdict === 'resend' && attempt < rotations && !init.signal?.aborted) continue;
        throw cleaned(err, (text) => scrub(text, via));
      }
      if (res.headers.get('cf-mitigated') === 'challenge') {
        if (attempt < rotations && !init.signal?.aborted && rotate(from, `${what}: Cloudflare's bot check`)) {
          await res.body?.cancel().catch(() => {});
          continue;
        }
        return res;
      }
      // The client reads every body with text(): an exit that drops mid-body moves the next request elsewhere.
      const text = res.text.bind(res);
      Object.defineProperty(res, 'text', {
        configurable: true,
        value: async () => {
          try {
            return await text();
          } catch (err) {
            // Whatever impit says (often a plain Error: "Error reading response stream: …"), the exit failed to
            // deliver the answer: the next request goes elsewhere. Only the caller's own abort is not the exit's doing.
            if (nameOf(err) !== 'AbortError') rotate(from, `${why(err)} (reading the answer)`);
            throw cleaned(err, (t) => scrub(t, via));
          }
        },
      });
      return res;
    }
  };
  return upstreamFetch as typeof fetch;
}

/**
 * An error reaches the logs and the stored scan as "<METHOD> <path> failed: <message>": no credentials in it, and
 * no cause, which the client would read instead. The name stays: the client tells a timeout and an abort by it.
 */
function cleaned(err: unknown, scrub: (text: string) => string): Error {
  const e = err as (Error & { status?: unknown }) | null;
  let message = scrub(String(e?.message ?? err));
  if (e?.name === 'ProxyTunnelError' && e.status === 402) message += " (the proxy's allowance is used up)";
  const clean = new Error(message);
  clean.name = nameOf(err);
  return clean;
}

/**
 * Replaces the proxy URL, its user name and its password (as written and decoded) wherever they appear: the
 * template's, and the URL a request went out on. With `{session}`, also the account part of the user name.
 */
function secretsOf(template: string | null): (text: string, via: string | null) => string {
  if (!template) return (text) => text;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const partsOf = (raw: string) => {
    const url = new URL(raw);
    return [raw, raw.replace(/\/$/, ''), url.href, url.password, decode(url.password), url.username, decode(url.username)];
  };
  const fixed = partsOf(template.replace(SESSION_PLACEHOLDER, '1'));
  if (rotatesExits(template)) {
    fixed.push(template, template.replace(/\/$/, ''));
    const user = /^[a-z][a-z0-9+.-]*:\/\/([^@/?#:]*)/i.exec(template)?.[1] ?? '';
    // Short pieces around the number (a lone "-") are not secrets, and replacing them would garble the message.
    for (const piece of user.split(SESSION_PLACEHOLDER)) {
      // With and without the separators around the number: "acct-" and "acct".
      for (const p of [piece, piece.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')]) if (p.length >= 3) fixed.push(p, decode(p));
    }
  }
  return (text, via) => {
    const secrets = [...fixed, ...(via ? partsOf(via) : [])]
      .filter((s) => s.length > 0)
      // Longest first, so a password inside the URL goes with the URL.
      .sort((a, b) => b.length - a.length);
    return secrets.reduce((out, s) => out.split(s).join('<proxy>'), text);
  };
}

/** Waits `ms`, or less if the signal aborts first (the request then fails on its own aborted signal). */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
