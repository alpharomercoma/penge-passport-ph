// Sends one push and says exactly what happened (spec: "Claims and sending", the transport's results). web-push
// signs and encrypts; node:https posts, once, with a total deadline that aborts the request. Nothing here logs:
// callers log loggable(result) with an internal id, never the endpoint, keys, payload or the push service's answer.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { PushSubscriptionInput } from '@penge/contracts';
import webpush from 'web-push';

export const SEND_DEADLINE_MS = 10_000;
export const BACKOFF_MAX_MS = 3_600_000;
export const BACKOFF_DEFAULT_MS = 600_000;
export const CHECKER_SLOTS = 8;
export const API_SLOTS = 4;

export type SendResult =
  | { kind: 'accepted'; status: 201 }
  | { kind: 'gone'; status: 404 | 410 }
  | { kind: 'throttled'; status: 429; retryAfterMs: number }
  | { kind: 'refused'; status: number | null }
  | { kind: 'rejected'; status: 400 | 401 | 403 }
  | { kind: 'bug'; status: number | null }
  | { kind: 'uncertain'; status: null };

export interface Transport {
  send(sub: PushSubscriptionInput, payload: string, opts: { ttl: number; urgency: 'high' | 'normal' }): Promise<SendResult>;
}

/** The default post's code for a failure or abort before its connection (TCP and TLS) was up: nothing left. */
export const NOT_SENT = 'PP_NOT_SENT';

/** Errors that mean the request never reached the push service. */
const NEVER_SENT = new Set([NOT_SENT, 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function retryAfter(raw: string | null, now: number): number {
  const t = (raw ?? '').trim();
  // Seconds: zero means now; more digits than an hour can have is the cap, before any arithmetic on them.
  if (/^\d+$/.test(t)) {
    const digits = t.replace(/^0+(?=\d)/, '');
    return digits.length > 7 ? BACKOFF_MAX_MS : Math.min(Number(digits) * 1000, BACKOFF_MAX_MS);
  }
  const at = Date.parse(t);
  if (!Number.isFinite(at)) return BACKOFF_DEFAULT_MS;
  return Math.min(Math.max(at - now, 0), BACKOFF_MAX_MS);
}

type Post = (url: string, init: { method: 'POST'; headers: Headers; body: Buffer | null; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

/**
 * fetch's shape over node:http(s), because fetch cannot say whether an aborted request left (spec: "A send aborted after
 * its request may have reached the push service is uncertain; one aborted before is refused"). Nothing is written to a
 * connection before it is up (TCP, and TLS for https), so a failure or abort before then rejects with cause.code NOT_SENT,
 * whatever caused it (refused, unreachable, a bad certificate, the deadline). Follows no redirect; reads no body.
 * Settles once, when the request has really ended (its 'close', or its upgraded socket's): until then the caller holds its
 * send slot. Throws at once (before connecting) for what it cannot send: another scheme, user info. Plain http is for
 * tests only (endpoints are checked as https before this).
 */
export const nodePost: Post = (url, init) => {
  const u = new URL(url);
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw new TypeError('cannot post to this endpoint');
  const notSent = (err: unknown) => new TypeError('fetch failed', { cause: Object.assign(new Error('not sent'), { code: NOT_SENT, cause: err }) });
  if (init.signal.aborted) return Promise.reject(notSent(init.signal.reason));
  const headers: Record<string, string> = {};
  init.headers.forEach((v, k) => (headers[k] = v));
  if (init.body) headers['content-length'] = String(init.body.length);
  const tls = u.protocol === 'https:';
  const req = (tls ? httpsRequest : httpRequest)(u, { method: 'POST', headers });
  return new Promise<Response>((resolve, reject) => {
    let up = false;
    let answered: Response | null = null;
    let failure: unknown = null;
    let settled = false;
    const answer = (code: number | undefined, raw: NodeJS.Dict<string | string[]>) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') h.set(k, v);
      // Response refuses a status outside 200–599 (a 101 that switched protocols, say): unexpected, so refused, as 500 is.
      answered ??= new Response(null, { status: code && code >= 200 && code <= 599 ? code : 500, headers: h });
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      init.signal.removeEventListener('abort', abort);
      if (answered) resolve(answered);
      else if (!up) reject(notSent(failure));
      else reject(new TypeError('fetch failed', { cause: failure ?? new Error('closed without an answer') }));
    };
    const abort = () => req.destroy(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    init.signal.addEventListener('abort', abort, { once: true });
    req.on('socket', (sock: Socket) => {
      // A pooled socket is up already (connected, and for https a protocol negotiated: 'unknown' until the handshake
      // ends); a new one is up at 'connect' (http) or 'secureConnect' (https).
      if (!sock.connecting && (!tls || /^TLS/.test((sock as TLSSocket).getProtocol() ?? ''))) up = true;
      else sock.once(tls ? 'secureConnect' : 'connect', () => (up = true));
    });
    req.on('error', (err) => (failure ??= err));
    req.on('response', (res) => {
      answer(res.statusCode, res.headers);
      res.on('error', () => {});
      res.resume();
    });
    let upgraded = false;
    req.on('upgrade', (res, sock) => {
      // The request's 'close' follows at once, before the socket has closed: only the socket's settles this send.
      upgraded = true;
      answer(res.statusCode, res.headers);
      sock.once('close', settle);
      sock.destroy();
    });
    req.on('close', () => {
      if (!upgraded) settle();
    });
    req.end(init.body ?? undefined);
  });
};

export function webPushTransport(
  vapid: { publicKey: string; privateKey: string; subject: string },
  o: { fetch?: Post; deadlineMs?: number; now?: () => number } = {},
): Transport {
  const post = o.fetch ?? nodePost;
  const deadlineMs = o.deadlineMs ?? SEND_DEADLINE_MS;
  const now = o.now ?? Date.now;
  return {
    async send(sub, payload, opts) {
      let details: { method: string; headers: Record<string, string | number>; body: Buffer | null; endpoint: string };
      try {
        details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          vapidDetails: vapid,
          TTL: opts.ttl,
          urgency: opts.urgency,
        }) as typeof details;
      } catch {
        return { kind: 'bug', status: null };
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(details.headers)) if (k.toLowerCase() !== 'content-length') headers.set(k, String(v));
      let sending: Promise<Response>;
      try {
        sending = post(details.endpoint, { method: 'POST', headers, body: details.body, redirect: 'manual', signal: AbortSignal.timeout(deadlineMs) });
      } catch {
        // Thrown before any request was made (an endpoint, header or option the post refused): our bug, never sent.
        return { kind: 'bug', status: null };
      }
      let res: Response;
      try {
        res = await sending;
      } catch (err) {
        const code = ((err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code) as string | undefined;
        if (typeof code === 'string' && NEVER_SENT.has(code)) return { kind: 'refused', status: null };
        return { kind: 'uncertain', status: null };
      }
      // The answer's body is never read: it is the push service's, and may echo what was sent.
      await res.body?.cancel().catch(() => {});
      const s = res.status;
      // The push protocol's acceptance is 201 Created; any other status is unexpected, so refused (spec: settlement table).
      if (s === 201) return { kind: 'accepted', status: 201 };
      if (s === 404 || s === 410) return { kind: 'gone', status: s };
      if (s === 429) return { kind: 'throttled', status: 429, retryAfterMs: retryAfter(res.headers.get('retry-after'), now()) };
      if (s === 400 || s === 401 || s === 403) return { kind: 'rejected', status: s };
      if (s === 413) return { kind: 'bug', status: 413 };
      return { kind: 'refused', status: s };
    },
  };
}

/** At most `max` sends at once in this process; a slot is held until its request has really ended. */
export class SendSlots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  get busy() {
    return this.running;
  }
  async take(): Promise<() => void> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    else this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    };
  }
}

export function loggable(r: SendResult): { status: number | null; category: SendResult['kind'] } {
  return { status: r.status, category: r.kind };
}
