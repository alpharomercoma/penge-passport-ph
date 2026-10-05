// The website's API. Caddy serves the React build and forwards /api/* here.
// It reads what the checker stored; only its lookups (lookups.ts) ask passport.gov.ph.
import {
  type AbroadResponse,
  type ApiError,
  type ConfirmPreview,
  type ConfirmResponse,
  type DeviceState,
  describePost,
  isCredential,
  isCalendarDate,
  isToken,
  isUnsubscribeToken,
  LIMITS,
  normalizeEmail,
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
import type { StoredStatus } from './checker.ts';
import type { PushConfig } from './config.ts';
import { emailIndex, signUnsubscribe } from './crypto.ts';
import { K, manilaDay } from './keys.ts';
import type { Kv } from './kv.ts';
import { API_LIMITS, hit, ipBucket, type Limit } from './limits.ts';
import type { Logger } from './log.ts';
import { LookupUnavailable, type Lookups, SCAN_RECENT_SECONDS } from './lookups.ts';
import type { Mailer } from './mailer.ts';
import { listDevices } from './push/devices.ts';
import { checkPushSubscription } from './push/endpoint.ts';
import { parseMeta } from './push/atomic.ts';
import { credentialHash, deviceCall, findDevice, turnOffDevice } from './push/register.ts';
import { PUSH_TIMEOUT_MS, PushPool, type PushTransport, pushDecision } from './push/sender.ts';
import { type Count, isPerson, type Stats } from './stats.ts';
import { confirm, createDeletion, createPending, deleteWithToken, type Keys, load, previewPending, unsubscribe } from './subscribers.ts';
import { confirmationEmail, deletionEmail } from './templates.ts';

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
  /** The day's numbers; without it nothing is counted. */
  stats?: Stats;
  /** Whether push can be turned on, and the VAPID key browsers subscribe with. */
  push: PushConfig;
  /** Sends pushes; without it test notifications answer 404. */
  pushTransport?: PushTransport;
}

export const SUBSCRIBE_MESSAGE =
  'Check your inbox for a confirmation link. It can take a few minutes; look in spam too. The alerts start once you confirm.';
export const DELETION_MESSAGE = 'Check your inbox for a link to stop alerts and delete your address. It can take a few minutes; look in spam too. Nothing changes until you press the button in the link.';

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
  /** Push for everyone (live), or only the owner's test addresses (owner). */
  const pushAllowed = (email: string) => deps.push.mode === 'live' || (deps.push.mode === 'owner' && deps.push.ownerEmails.includes(email));

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

  const fail = (c: Context, status: 400 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503, error: string, fields?: ApiError['fields']) =>
    c.json<ApiError>(fields ? { error, fields } : { error }, status);

  // Counters are kept per network address, under a keyed hash of it: Redis
  // never holds a visitor's IP address.
  const visitor = (c: Context) => createHmac('sha256', keys.index).update(`ip:${ipOf(c)}`).digest('base64url').slice(0, 22);
  const limited = async (c: Context, limit: Limit) => !(await hit(kv, limit, visitor(c), now()));

  const TOO_MANY = 'Too many requests from your network. Try again in an hour.';

  // The day's numbers (stats.ts), written after the answer and never waited for.
  const seen = (c: Context, abroad = false) => deps.stats?.visit(ipOf(c), c.req.header('user-agent'), { abroad });
  // A person on the site may tap a day next: have a DFA session ready (lookups.ts), without waiting for it.
  const warm = (c: Context) => {
    if (isPerson(c.req.header('user-agent'))) void deps.lookups?.warm();
  };
  const byPerson = (c: Context, name: Count) => {
    if (isPerson(c.req.header('user-agent'))) deps.stats?.count(name);
  };

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
    seen(c);
    warm(c);
    const raw = await kv.get(K.status);
    const stored = raw ? (JSON.parse(raw) as StoredStatus) : null;
    return c.json<StatusResponse>({
      checkedAt: stored?.checkedAt ?? null,
      lastHealthyAt: stored?.lastHealthyAt ?? null,
      healthy: stored?.healthy ?? false,
      mailLive: mailer.mode === 'live',
      sites: stored?.sites ?? [],
      push: deps.push.mode,
      vapidPublicKey: deps.push.vapid?.publicKey ?? null,
    });
  });

  app.get('/api/abroad', async (c) => {
    if (await limited(c, API_LIMITS.readPerIp)) return fail(c, 429, TOO_MANY);
    seen(c, true);
    return c.json<AbroadResponse>(await abroadResponse(kv));
  });

  // -- Office details: dates for a group size, and the hours of one day ------

  async function officeFrom(raw: string | undefined) {
    if (!raw || !/^\d{1,7}$/.test(raw)) return null;
    const stored = await kv.get(K.status);
    const status = stored ? (JSON.parse(stored) as StoredStatus) : null;
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
    seen(c);
    warm(c);
    if (applicants === 1) deps.stats?.officeView(office.site.id, c.req.header('user-agent'));
    else byPerson(c, 'groupChecks');
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
        ...(!office.site.ok ? { warning: 'The latest scan could not verify this office. Showing its last known dates.' } : {}),
      };
      if (!deps.lookups) return c.json(scan);
      const newer = (other: OfficeDates | null) => (other && other.checkedAt >= scan.checkedAt ? other : scan);
      if (now() - Date.parse(scan.checkedAt) < SCAN_RECENT_SECONDS * 1000) {
        return c.json(newer(await deps.lookups.peekDates(office.site.id, 1)));
      }
      try {
        return c.json(newer(await deps.lookups.dates(office.site.id, 1)));
      } catch (err) {
        if (err instanceof LookupUnavailable) return office.never ? lookupFailed(c, err) : c.json({ ...scan, warning: err.message });
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
    seen(c);
    byPerson(c, 'hourLookups');
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
    const ch = request.channels;
    if (ch?.pushOn && !pushAllowed(request.email)) {
      return fail(c, 400, 'Please fix the highlighted fields.', { channels: 'Notifications are not available yet.' });
    }
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
    // The devices this address already has with notifications keep them whatever this request says.
    const existing = await kv.get(K.emailIndex(emailIndex(request.email, keys.index)));
    const devicesKept = existing && request.channels ? (await listDevices(kv, existing)).filter((d) => d.meta.state === 'r').length : 0;
    // A page from before channels keeps the address's email setting: word the email for it.
    const emailOnNow = existing && !request.channels ? (await load(kv, existing))?.emailOn : undefined;
    const content = confirmationEmail({
      confirmUrl: `${deps.publicBaseUrl}/confirm#token=${token}`,
      deletionUrl: `${deps.publicBaseUrl}/delete-data`,
      sites: chosen,
      applicants: request.applicants,
      pace: request.pace,
      ...(emailOnNow === false ? { emailOn: false } : {}),
      ...(request.channels
        ? { channels: { emailOn: request.channels.emailOn, pushOn: request.channels.pushOn, device: request.channels.device, requestedAt: new Date(now()).toISOString(), devicesKept } }
        : {}),
    });
    try {
      await mailer.send({ ...content, to: request.email, kind: 'confirm' });
      deps.stats?.count('confirmEmails');
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
    const body = parsed.body as { token?: unknown; acknowledge?: { emailOn?: unknown; pushOn?: unknown } } | null;
    const token = body?.token;
    if (!isToken(token)) return fail(c, 400, 'That link is not valid. Copy the whole link from the email.');
    const a = body?.acknowledge;
    const acknowledge = a && typeof a.emailOn === 'boolean' && typeof a.pushOn === 'boolean' ? { emailOn: a.emailOn, pushOn: a.pushOn } : undefined;
    const result = await confirm(kv, keys, token, now(), acknowledge, { pushAllowed });
    if (result.status === 'invalid') return fail(c, 404, 'That link has expired or was already used. Subscribe again to get a new one.');
    if (result.status === 'reload') {
      return c.json<ApiError>({ error: 'This page is out of date. Reload it, then open the confirmation link from your email again.', code: 'reload' }, 409);
    }
    if (result.status === 'full') {
      return c.json<ApiError>({ error: 'This alert already has notifications on 5 devices. Turn them off on one of them first.', code: 'full' }, 409);
    }
    if (result.status === 'push-unavailable') {
      const why = {
        owned: 'This device already gets alerts for another email address. Turn notifications off for that address on this device, then fill in the form again.',
        revoked: 'Notifications were turned off on this device. Fill in the form again to turn them back on, or choose email.',
        off: 'Notifications are not available right now. Fill in the form again with email on.',
      }[result.reason];
      return c.json<ApiError>({ error: why, code: 'push-unavailable' }, 409);
    }
    deps.stats?.count(result.status === 'confirmed' ? 'confirmed' : 'updated');
    return c.json<ConfirmResponse>({ status: result.status, siteIds: result.siteIds, applicants: result.applicants, pace: result.pace, channels: result.channels });
  });

  app.post('/api/confirm/preview', async (c) => {
    if (await limited(c, API_LIMITS.tokenPerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const token = (parsed.body as { token?: unknown } | null)?.token;
    if (!isToken(token)) return fail(c, 400, 'That link is not valid. Copy the whole link from the email.');
    const preview = await previewPending(kv, token);
    if (!preview) return fail(c, 404, 'That link has expired or was already used. Subscribe again to get a new one.');
    return c.json<ConfirmPreview>(preview);
  });

  /**
   * A device call: counted per network, and per credential unless it turns the device off
   * (turning off must always work for the device's holder; it only removes).
   */
  async function deviceRequest(c: Context, opts: { perCredential: boolean } = { perCredential: true }): Promise<{ ok: true; credential: string; body: Record<string, unknown> } | { ok: false; res: Response }> {
    if (await limited(c, API_LIMITS.devicePerIp)) return { ok: false, res: fail(c, 429, TOO_MANY) };
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed;
    const body = (parsed.body ?? {}) as Record<string, unknown>;
    if (!isCredential(body.credential)) return { ok: false, res: fail(c, 400, 'That device answer is not valid.') };
    if (opts.perCredential && !(await hit(kv, API_LIMITS.devicePerCredential, credentialHash(body.credential), now()))) return { ok: false, res: fail(c, 429, TOO_MANY) };
    return { ok: true, credential: body.credential, body };
  }

  app.post('/api/push/device', async (c) => {
    const r = await deviceRequest(c);
    if (!r.ok) return r.res;
    let subscription = null;
    let revision: number | null = null;
    if (r.body.subscription !== undefined) {
      subscription = checkPushSubscription(r.body.subscription);
      revision = typeof r.body.revision === 'number' && Number.isSafeInteger(r.body.revision) && r.body.revision >= 1 ? r.body.revision : null;
      if (!subscription || revision === null) return fail(c, 400, 'That device answer is not valid.');
    }
    const state = await deviceCall(kv, keys, { credential: r.credential, subscription, revision, now: now() });
    return c.json<{ state: DeviceState }>({ state });
  });

  app.delete('/api/push/device', async (c) => {
    const r = await deviceRequest(c, { perCredential: false });
    if (!r.ok) return r.res;
    const { noChannel } = await turnOffDevice(kv, r.credential);
    return c.json({ ok: true, noChannel });
  });

  app.post('/api/push/test', async (c) => {
    const r = await deviceRequest(c);
    if (!r.ok) return r.res;
    const hash = credentialHash(r.credential);
    const found = await findDevice(kv, hash);
    const subscriber = found ? await load(kv, found.subscriberId) : null;
    const meta = found ? (await kv.hGetAll(K.pushMeta(found.subscriberId)))[found.deviceId] : undefined;
    if (!found || !subscriber || !meta || parseMeta(meta).state !== 'r' || !deps.pushTransport) {
      return fail(c, 404, 'Notifications are not on for this device yet.');
    }
    if (await kv.get(K.pushPaused)) return fail(c, 503, 'Notifications are paused for maintenance. Try again later.');
    if (!(await hit(kv, API_LIMITS.testPerDevice, hash, now()))) return fail(c, 429, 'You can send 3 test notifications an hour. Try again later.');
    const pool = new PushPool({ transport: deps.pushTransport, inFlight: 1, budgetMs: PUSH_TIMEOUT_MS * 2, timeoutMs: PUSH_TIMEOUT_MS, now });
    const payload = JSON.stringify({ v: 1, title: 'Test notification', body: 'Notifications work on this device.', tag: 'test', url: {} });
    const { any } = await pushDecision({ kv, keys, pool, log, now }, { subscriberId: found.subscriberId, index: subscriber.index, payload, onlyDeviceId: found.deviceId });
    if (any === 'none') return fail(c, 404, 'That test did not reach this device. Turn notifications off and on again.');
    return c.json({ ok: true });
  });

  app.post('/api/deletion-request', async (c) => {
    if (mailer.mode !== 'live') return fail(c, 503, 'Email links are not switched on yet. Try again soon.');
    if (await kv.get(K.mailPaused)) return fail(c, 503, 'Email is paused for maintenance. Try again later.');
    if (await limited(c, API_LIMITS.subscribePerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body as { email?: unknown; website?: unknown } | null;
    const email = normalizeEmail(body?.email);
    if (!email) return fail(c, 400, 'Enter a valid email address, like juan@example.com.', { email: 'Enter a valid email address, like juan@example.com.' });
    const accepted = () => c.json({ message: DELETION_MESSAGE }, 202);
    if (body?.website) return accepted();
    // Share the confirmation limits: requesting deletion cannot double what
    // either public form can send to an address or in an hour.
    if (!(await hit(kv, API_LIMITS.confirmationsPerEmail, emailIndex(email, keys.index), now()))) return accepted();
    if (!(await hit(kv, API_LIMITS.confirmationsPerHour, 'all', now()))) return fail(c, 503, 'We are sending a lot of emails right now. Try again in an hour.');
    const token = await createDeletion(kv, keys, email);
    try {
      await mailer.send({ ...deletionEmail({ deletionUrl: `${deps.publicBaseUrl}/delete-data#token=${token}` }), to: email, kind: 'deletion' });
    } catch (err) {
      log.error('deletion email failed', { err: err as Error });
      return fail(c, 503, 'We could not send the deletion link. Try again later.');
    }
    return accepted();
  });

  app.post('/api/delete-data', async (c) => {
    if (await limited(c, API_LIMITS.tokenPerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const token = (parsed.body as { token?: unknown } | null)?.token;
    if (!isToken(token)) return fail(c, 400, 'That deletion link is not valid. Request a new link.');
    const result = await deleteWithToken(kv, token);
    if (!result.valid) return fail(c, 404, 'That deletion link has expired or was already used. Request a new link.');
    if (result.removed) deps.stats?.count('unsubscribed');
    return c.json({ ok: true });
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
    if (removed) deps.stats?.count('unsubscribed');
    return c.json({ ok: true });
  });

  app.notFound((c) => fail(c, 404, 'Not found.'));
  app.onError((err, c) => {
    log.error('api error', { path: c.req.path, err });
    return fail(c, 500, 'Something went wrong on our side. Try again later.');
  });

  return app;
}
