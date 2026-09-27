// The website's API. Caddy serves the React build and forwards /api/* here.
// It reads what the checker stored; only its lookups (lookups.ts) ask passport.gov.ph.
import {
  type AbroadResponse,
  type ApiError,
  type ConfirmResponse,
  describePost,
  isCalendarDate,
  isToken,
  isUnsubscribeToken,
  LIMITS,
  type OfficeDates,
  type SiteStatus,
  type SiteSummary,
  type StatusResponse,
  type SubscribeResponse,
  validateSubscribe,
} from '@penge/contracts';
import { createHmac } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { abroadResponse, catalogPosts } from './abroad.ts';
import { emailIndex, signUnsubscribe } from './crypto.ts';
import { K, manilaDay } from './keys.ts';
import type { Kv } from './kv.ts';
import { API_LIMITS, hit, ipBucket, type Limit } from './limits.ts';
import type { Logger } from './log.ts';
import { LookupUnavailable, type Lookups, SCAN_RECENT_SECONDS } from './lookups.ts';
import type { Mailer } from './mailer.ts';
import { confirm, createPending, type Keys, unsubscribe } from './subscribers.ts';
import { confirmationEmail } from './templates.ts';

export interface ApiDeps {
  kv: Kv;
  keys: Keys;
  mailer: Mailer;
  log: Logger;
  publicBaseUrl: string;
  now?: () => number;
  /** Test hook: the address the request came from, when there is no socket. */
  clientIp?: (c: Context) => string;
  /** On-demand office details; without them those routes answer 503. */
  lookups?: Lookups;
}

export const SUBSCRIBE_MESSAGE =
  'Check your inbox for a confirmation link. It can take a few minutes; look in spam too. The alerts start once you confirm.';

const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;
const SITES_CACHE_MS = 60_000;

export function unsubscribeLinks(base: string, subscriberId: string, keys: Keys) {
  const token = signUnsubscribe(subscriberId, keys.token);
  return {
    /** Opens a page with a button; mail scanners that follow links change nothing. */
    page: `${base}/unsubscribe#token=${token}`,
    /** For the List-Unsubscribe header: mail providers POST here (RFC 8058). */
    oneClick: `${base}/api/unsubscribe?token=${token}`,
  };
}

/**
 * Who to count a request against. Caddy, on this machine, sets X-Forwarded-For
 * to the real client address; from anywhere else the header is ignored,
 * because anyone can write it.
 */
export function clientAddress(peer: string, forwardedFor: string | undefined): string {
  const forwarded = LOOPBACK.test(peer) ? forwardedFor?.split(',').at(-1)?.trim() : undefined;
  return ipBucket(forwarded || peer);
}

export function createApi(deps: ApiDeps) {
  const { kv, keys, mailer, log } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  let sitesCache: { at: number; sites: SiteSummary[] } | null = null;
  async function sites(): Promise<SiteSummary[] | null> {
    if (sitesCache && now() - sitesCache.at < SITES_CACHE_MS) return sitesCache.sites;
    const raw = await kv.get(K.sites);
    if (!raw) return null;
    // Posts abroad too, named the way people know them: "Copenhagen (Philippine Embassy, Denmark)".
    const abroad = (await catalogPosts(kv)).map((p) => {
      const d = describePost(p.name, p.country);
      return { id: p.id, name: `${d.place} (${d.detail})` };
    });
    sitesCache = { at: now(), sites: [...(JSON.parse(raw) as SiteSummary[]), ...abroad] };
    return sitesCache.sites;
  }

  const ipOf = (c: Context) =>
    deps.clientIp
      ? deps.clientIp(c)
      : clientAddress(getConnInfo(c).remote.address ?? 'unknown', c.req.header('x-forwarded-for'));

  const fail = (c: Context, status: 400 | 403 | 404 | 413 | 415 | 429 | 500 | 503, error: string, fields?: ApiError['fields']) =>
    c.json<ApiError>(fields ? { error, fields } : { error }, status);

  // Counters are kept per network address, under a keyed hash of it: Redis
  // never holds a visitor's IP address.
  const visitor = (c: Context) => createHmac('sha256', keys.index).update(`ip:${ipOf(c)}`).digest('base64url').slice(0, 22);
  const limited = async (c: Context, limit: Limit) => !(await hit(kv, limit, visitor(c), now()));

  const TOO_MANY = 'Too many requests from your network. Try again in an hour.';

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });
  app.use('/api/*', bodyLimit({ maxSize: 4 * 1024, onError: (c) => fail(c, 413, 'That request is too large.') }));

  /** For deploys and monitoring: also proves Redis answers. */
  app.get('/api/ready', async (c) => {
    try {
      await Promise.race([
        kv.get(K.status),
        new Promise((_, reject) => setTimeout(() => reject(new Error('redis timeout')), 2000)),
      ]);
      return c.json({ ok: true });
    } catch (err) {
      log.error('not ready', { err: err as Error });
      return fail(c, 503, 'Not ready.');
    }
  });

  app.get('/api/status', async (c) => {
    if (await limited(c, API_LIMITS.readPerIp)) return fail(c, 429, TOO_MANY);
    const raw = await kv.get(K.status);
    const stored = raw ? (JSON.parse(raw) as Omit<StatusResponse, 'mailLive'>) : null;
    return c.json<StatusResponse>({
      checkedAt: stored?.checkedAt ?? null,
      lastHealthyAt: stored?.lastHealthyAt ?? null,
      healthy: stored?.healthy ?? false,
      mailLive: mailer.mode === 'live',
      sites: stored?.sites ?? [],
    });
  });

  app.get('/api/abroad', async (c) => {
    if (await limited(c, API_LIMITS.readPerIp)) return fail(c, 429, TOO_MANY);
    return c.json<AbroadResponse>(await abroadResponse(kv));
  });

  // -- Office details: dates for a group size, and the hours of one day ------

  async function officeFrom(raw: string | undefined) {
    if (!raw || !/^\d{1,7}$/.test(raw)) return null;
    const stored = await kv.get(K.status);
    const status = stored ? (JSON.parse(stored) as Omit<StatusResponse, 'mailLive'>) : null;
    const site = status?.sites.find((s) => s.id === Number(raw));
    if (!site) {
      // A post abroad, checked about hourly: one never checked yet has nothing
      // stored to fall back on, so its dates must come from the DFA.
      const post = (await abroadResponse(kv)).posts.find((p) => p.id === Number(raw));
      return post ? { site: post as SiteStatus, checkedAt: post.checkedAt ?? new Date(0).toISOString(), never: !post.checkedAt } : null;
    }
    // An office whose latest check failed shows older dates: say when they were read.
    const checkedAt = site.checkedAt ?? status?.lastHealthyAt ?? status?.checkedAt ?? new Date(now()).toISOString();
    return status ? { site, checkedAt, never: false } : null;
  }

  const peopleFrom = (raw: string | undefined) => {
    const n = raw === undefined ? 1 : Number(raw);
    return /^\d{1,2}$/.test(raw ?? '1') && Number.isInteger(n) && n >= 1 && n <= LIMITS.maxApplicants ? n : null;
  };

  const lookupFailed = (c: Context, err: unknown) => {
    if (err instanceof LookupUnavailable) return fail(c, 503, err.message);
    throw err;
  };

  app.get('/api/offices/:id/dates', async (c) => {
    if (await limited(c, API_LIMITS.lookupPerIp)) return fail(c, 429, TOO_MANY);
    const office = await officeFrom(c.req.param('id'));
    if (!office) return fail(c, 404, 'There is no office with that number.');
    const applicants = peopleFrom(c.req.query('applicants'));
    if (applicants === null) return fail(c, 400, `Choose from 1 to ${LIMITS.maxApplicants} people.`);
    // For one person the scans have the answer. While they keep up, the last
    // one (or a newer stored lookup) is it, and the DFA is not asked again;
    // when they fall behind, a fresh look is tried, and the newer answer wins.
    if (applicants === 1) {
      const scan: OfficeDates = {
        siteId: office.site.id,
        applicants,
        openDates: office.site.openDates,
        fullDates: office.site.fullDates ?? [],
        windowEnd: office.site.windowEnd ?? null,
        checkedAt: office.checkedAt,
      };
      if (!deps.lookups) return c.json(scan);
      const newer = (other: OfficeDates | null) => (other && other.checkedAt >= scan.checkedAt ? other : scan);
      if (now() - Date.parse(scan.checkedAt) < SCAN_RECENT_SECONDS * 1000) {
        return c.json(newer(await deps.lookups.peekDates(office.site.id, 1)));
      }
      try {
        return c.json(newer(await deps.lookups.dates(office.site.id, 1)));
      } catch (err) {
        if (err instanceof LookupUnavailable) return office.never ? lookupFailed(c, err) : c.json(scan);
        throw err;
      }
    }
    if (!deps.lookups) return fail(c, 503, 'Group sizes can’t be checked right now.');
    try {
      return c.json(await deps.lookups.dates(office.site.id, applicants));
    } catch (err) {
      return lookupFailed(c, err);
    }
  });

  app.get('/api/offices/:id/times', async (c) => {
    if (await limited(c, API_LIMITS.lookupPerIp)) return fail(c, 429, TOO_MANY);
    const office = await officeFrom(c.req.param('id'));
    if (!office) return fail(c, 404, 'There is no office with that number.');
    const applicants = peopleFrom(c.req.query('applicants'));
    if (applicants === null) return fail(c, 400, `Choose from 1 to ${LIMITS.maxApplicants} people.`);
    const date = c.req.query('date') ?? '';
    const today = manilaDay(now());
    const latest = manilaDay(now() + 200 * 86_400_000);
    if (!isCalendarDate(date) || date < today || date > latest) {
      return fail(c, 400, 'Choose a date from today on.');
    }
    if (!deps.lookups) return fail(c, 503, 'Times can’t be checked right now.');
    try {
      return c.json(await deps.lookups.times(office.site.id, date, applicants));
    } catch (err) {
      return lookupFailed(c, err);
    }
  });

  /** JSON only: browsers cannot send it cross-site without asking first (CORS), which we never allow. */
  async function jsonBody(c: Context): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json\s*(?:;|$)/i.test(type)) {
      return { ok: false, res: fail(c, 415, 'Send the form as JSON.') };
    }
    try {
      return { ok: true, body: await c.req.json() };
    } catch {
      return { ok: false, res: fail(c, 400, 'That request is not valid JSON.') };
    }
  }

  app.post('/api/subscribe', async (c) => {
    // Until mail is live nobody could confirm, so don't store their address at all.
    if (mailer.mode !== 'live') return fail(c, 503, 'Email alerts are not switched on yet. Try again soon.');
    // The operator's emergency stop covers confirmations too, not only alerts.
    if (await kv.get(K.mailPaused)) return fail(c, 503, 'Email is paused for maintenance. Try again later.');
    if (await limited(c, API_LIMITS.subscribePerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const list = await sites();
    if (!list) return fail(c, 503, 'The site list is not ready yet. Try again in a few minutes.');
    const checked = validateSubscribe(parsed.body, new Set(list.map((s) => s.id)));
    if (!checked.ok) return fail(c, 400, 'Please fix the highlighted fields.', checked.errors);

    const request = checked.value;
    const accepted = () => c.json<SubscribeResponse>({ message: SUBSCRIBE_MESSAGE }, 202);
    // Limits on what reaches an inbox are silent: the answer is the same either
    // way, so the form cannot be used to learn anything about an address.
    if (!(await hit(kv, API_LIMITS.confirmationsPerEmail, emailIndex(request.email, keys.index), now()))) {
      log.warn('confirmation limit for one address');
      return accepted();
    }
    if (!(await hit(kv, API_LIMITS.confirmationsPerHour, 'all', now()))) {
      log.warn('confirmation limit for the hour');
      return fail(c, 503, 'We are sending a lot of emails right now. Try again in an hour.');
    }

    const token = await createPending(kv, keys, request, now());
    const chosen = list.filter((s) => request.siteIds.includes(s.id));
    const content = confirmationEmail({
      confirmUrl: `${deps.publicBaseUrl}/confirm#token=${token}`,
      sites: chosen,
      applicants: request.applicants,
    });
    try {
      await mailer.send({ ...content, to: request.email, kind: 'confirm' });
    } catch (err) {
      log.error('confirmation email failed', { err: err as Error });
      return fail(c, 503, 'We could not send the confirmation email. Try again later.');
    }
    return accepted();
  });

  app.post('/api/confirm', async (c) => {
    if (await limited(c, API_LIMITS.tokenPerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const token = (parsed.body as { token?: unknown } | null)?.token;
    if (!isToken(token)) return fail(c, 400, 'That link is not valid. Copy the whole link from the email.');
    const result = await confirm(kv, token, now());
    if (result.status === 'invalid') {
      return fail(c, 404, 'That link has expired or was already used. Subscribe again to get a new one.');
    }
    return c.json<ConfirmResponse>({ status: result.status, siteIds: result.siteIds, applicants: result.applicants });
  });

  // Some mail apps open the List-Unsubscribe link instead of POSTing to it:
  // send them to the page with the button, never unsubscribe on a GET.
  app.get('/api/unsubscribe', (c) => {
    const token = c.req.query('token');
    const page = `${deps.publicBaseUrl}/unsubscribe`;
    return c.redirect(isUnsubscribeToken(token) ? `${page}#token=${token}` : page, 303);
  });

  app.post('/api/unsubscribe', async (c) => {
    if (await limited(c, API_LIMITS.tokenPerIp)) return fail(c, 429, TOO_MANY);
    const type = c.req.header('content-type') ?? '';
    let token: unknown;
    if (/^application\/x-www-form-urlencoded\s*(?:;|$)/i.test(type) || /^multipart\/form-data/i.test(type)) {
      // RFC 8058 one-click: the mail provider POSTs "List-Unsubscribe=One-Click"
      // to the URL from the header, which carries the token.
      const form = await c.req.parseBody().catch(() => null);
      if (form?.['List-Unsubscribe'] !== 'One-Click') return fail(c, 400, 'That request is not valid.');
      token = c.req.query('token');
    } else {
      const parsed = await jsonBody(c);
      if (!parsed.ok) return parsed.res;
      token = (parsed.body as { token?: unknown } | null)?.token;
    }
    if (!isUnsubscribeToken(token)) return fail(c, 400, 'That link is not valid. Copy the whole link from the email.');
    // The same answer whether or not the subscription still existed.
    const removed = await unsubscribe(kv, keys, token);
    log.info('unsubscribe', { removed });
    return c.json({ ok: true });
  });

  app.notFound((c) => fail(c, 404, 'Not found.'));
  app.onError((err, c) => {
    log.error('api error', { path: c.req.path, err });
    return fail(c, 500, 'Something went wrong on our side. Try again later.');
  });

  return app;
}
