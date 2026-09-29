import { parseHttpDate } from './rate-limit.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Minimal cookie jar for a single origin. The site sets only a handful of
 * path=/ cookies (anti-forgery token, load-balancer affinity), so domain and
 * path matching are not needed.
 */
export class CookieJar {
  private readonly cookies = new Map<string, { value: string; expiresAt: number }>();

  store(headers: Headers) {
    for (const line of headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // A control character (CR, LF, NUL…) would break or inject into our own Cookie header.
      if (CONTROL.test(name) || CONTROL.test(value)) continue;
      let expiresAt = Number.POSITIVE_INFINITY;
      let maxAgeSeen = false;
      for (const attr of attrs) {
        const eqAt = attr.indexOf('=');
        const k = (eqAt === -1 ? attr : attr.slice(0, eqAt)).trim().toLowerCase();
        const v = eqAt === -1 ? '' : attr.slice(eqAt + 1).trim();
        // RFC 6265: Max-Age is an optionally negative integer and wins over Expires.
        if (k === 'max-age' && /^-?[0-9]+$/.test(v)) {
          expiresAt = Date.now() + Math.max(-1, Math.min(Number(v), 1e9)) * 1000;
          maxAgeSeen = true;
        } else if (k === 'expires' && !maxAgeSeen) {
          const t = parseHttpDate(v);
          if (t !== undefined) expiresAt = t;
        }
      }
      if (expiresAt <= Date.now()) this.cookies.delete(name);
      else this.cookies.set(name, { value, expiresAt });
    }
  }

  header(): string | undefined {
    const now = Date.now();
    const parts: string[] = [];
    for (const [name, c] of this.cookies) {
      if (c.expiresAt <= now) this.cookies.delete(name);
      else parts.push(`${name}=${c.value}`);
    }
    return parts.length ? parts.join('; ') : undefined;
  }

  clear() {
    this.cookies.clear();
  }
}

export interface Session {
  token: string;
  serverToday: string | null;
  maxDate: string | null;
  createdAt: number;
  lastUsedAt: number;
  /** When the token last proved good: when it was issued, or last got a non-empty answer. */
  confirmedAt: number;
}

/** The site logs idle visitors out after 10 minutes; refresh a little before that. */
export const SESSION_IDLE_MS = 9 * 60 * 1000;
export const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * A token that proved good this recently is not doubted: an empty answer about
 * a day's hours then means no hours are published, not a rejected token.
 */
export const TOKEN_TRUSTED_MS = 2 * 60 * 1000;

export function isFresh(session: Session | null, now = Date.now()): session is Session {
  return (
    session !== null &&
    now - session.lastUsedAt < SESSION_IDLE_MS &&
    now - session.createdAt < SESSION_MAX_AGE_MS
  );
}
