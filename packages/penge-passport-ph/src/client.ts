import { raceAbort, sleep } from './async.js';
import { TtlCache } from './cache.js';
import { RateLimitError, SessionError, UpstreamError } from './errors.js';
import {
  isIsoDate,
  parseAvailability,
  parseBootstrap,
  parseCountries,
  parseJson,
  parseSites,
  parseTimeSlots,
} from './parse.js';
import {
  defaultStateDir,
  gateFor,
  parseRetryAfter,
  resolveLimits,
  type HostGate,
} from './rate-limit.js';
import { PHILIPPINES, REGIONS } from './regions.js';
import {
  CookieJar,
  isFresh,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  type Session,
  TOKEN_TRUSTED_MS,
} from './session.js';
import type {
  Availability,
  AvailabilityQuery,
  Country,
  DayAvailability,
  Region,
  Site,
  TimeSlot,
  TimeSlotQuery,
} from './types.js';
import { HOMEPAGE, NAME, VERSION } from './meta.js';

export const DEFAULT_BASE_URL = 'https://passport.gov.ph';

/** Endpoints, as named in the site's own scripts. */
export const ENDPOINTS = Object.freeze({
  bootstrap: '/appointment',
  countries: '/countries',
  sites: '/sites',
  availability: '/appointment/timeslot/available',
  timeSlots: '/appointment/timeslot',
});

const MIN_AVAILABILITY_TTL_MS = 30_000;
const MIN_WATCH_INTERVAL_MS = 60_000;
/** If the server has no booking horizon on the page, look this far ahead. */
const FALLBACK_HORIZON_DAYS = 180;
const HOUR_MS = 60 * 60 * 1000;

export interface PengePassportPHOptions {
  baseUrl?: string;
  /** Gap between requests. Minimum 2000 ms, default 3000 ms. */
  minIntervalMs?: number;
  /** Rolling-hour request budget per host, shared by every process of this user. Max 1200, default 300. */
  maxRequestsPerHour?: number;
  /** Longest a call may wait in the queue before it is refused with `RateLimitError`. Default 60 s. */
  maxWaitMs?: number;
  /** How long an availability or time-slot answer is reused. Minimum 30 s, default 60 s. */
  availabilityTtlMs?: number;
  /** How long country and site lists are reused. Default 6 h. */
  directoryTtlMs?: number;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Your email or URL, added to the User-Agent so the site's operators can reach you. */
  contact?: string;
  /**
   * Directory where the rate limiter's state is shared between processes.
   * Default: see `defaultStateDir()` (`~/.local/state/penge-passport-ph`).
   */
  stateDir?: string;
  /** Custom fetch (proxies, tests). Requests still pass through the rate limiter. */
  fetch?: typeof fetch;
}

export interface WatchOptions {
  siteIds: number[];
  /** Time between rounds. Minimum 60 s, default 5 min. */
  intervalMs?: number;
  /** People in the booking. Default 1. */
  applicants?: number;
  from?: string;
  to?: string;
  signal?: AbortSignal;
}

export type WatchEvent =
  | {
      type: 'availability';
      siteId: number;
      availability: Availability;
      /** Dates that became available since the previous round. */
      opened: string[];
      /** Dates that stopped being available since the previous round. */
      closed: string[];
      /** First result for this site in this watch. */
      initial: boolean;
    }
  | { type: 'error'; siteId: number; error: Error };

type Form = Record<string, string | number>;

/** Marker for the empty 200 the site sends for a rejected anti-forgery token. */
const EMPTY = Symbol('empty body');

/**
 * PengePassportPH: read-only client for passport.gov.ph appointment availability. Every
 * request goes through the shared rate limiter; nothing here can select or
 * reserve a time slot.
 */
export class PengePassportPH {
  private readonly baseUrl: string;
  private readonly gate: HostGate;
  private readonly limits: { minIntervalMs: number; maxRequestsPerHour: number };
  private readonly maxWaitMs: number;
  private readonly availabilityTtlMs: number;
  private readonly directoryTtlMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly jar = new CookieJar();
  private readonly cache = new TtlCache<unknown>();
  private session: Session | null = null;
  private pendingSession: Promise<Session> | null = null;

  constructor(options: PengePassportPHOptions = {}) {
    const base = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    this.baseUrl = base.origin;
    this.limits = resolveLimits(options);
    this.maxWaitMs = options.maxWaitMs ?? 60_000;
    if (!(this.maxWaitMs >= 0)) {
      throw new RangeError(`maxWaitMs must be 0 or more milliseconds (got ${this.maxWaitMs})`);
    }
    this.availabilityTtlMs = options.availabilityTtlMs ?? 60_000;
    if (this.availabilityTtlMs < MIN_AVAILABILITY_TTL_MS) {
      throw new RangeError(`availabilityTtlMs must be at least ${MIN_AVAILABILITY_TTL_MS}`);
    }
    this.directoryTtlMs = options.directoryTtlMs ?? 6 * HOUR_MS;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (options.contact !== undefined) assertContact(options.contact);
    this.userAgent = userAgent(options.contact);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.gate = gateFor(base.host, options.stateDir ?? defaultStateDir());
  }

  regions(): readonly Region[] {
    return REGIONS;
  }

  async countries(regionId: number, opts: { signal?: AbortSignal } = {}): Promise<Country[]> {
    assertPositiveInt(regionId, 'regionId');
    const { value } = await this.cache.get(
      `countries:${regionId}`,
      this.directoryTtlMs,
      (signal) =>
        this.send('POST', ENDPOINTS.countries, { form: { regionId }, signal }, (text) =>
          parseCountries(parseJson(text, ENDPOINTS.countries), ENDPOINTS.countries),
        ),
      opts.signal,
    );
    return structuredClone(value as Country[]);
  }

  /** Sites for a region and country. Defaults to the Philippines. */
  async sites(
    opts: { regionId?: number; countryId?: number; signal?: AbortSignal } = {},
  ): Promise<Site[]> {
    const regionId = opts.regionId ?? PHILIPPINES.regionId;
    const countryId = opts.countryId ?? PHILIPPINES.countryId;
    assertPositiveInt(regionId, 'regionId');
    assertPositiveInt(countryId, 'countryId');
    const { value } = await this.cache.get(
      `sites:${regionId}:${countryId}`,
      this.directoryTtlMs,
      (signal) =>
        this.send('POST', ENDPOINTS.sites, { form: { regionId, countryId }, signal }, (text) =>
          parseSites(parseJson(text, ENDPOINTS.sites), ENDPOINTS.sites),
        ),
      opts.signal,
    );
    return structuredClone(value as Site[]);
  }

  /** Case-insensitive search over site names and descriptions. */
  async findSites(
    query: string,
    opts: { regionId?: number; countryId?: number; signal?: AbortSignal } = {},
  ): Promise<Site[]> {
    const needle = query.trim().toLowerCase();
    const all = await this.sites(opts);
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        (s.description ?? '').toLowerCase().includes(needle),
    );
  }

  /** Which dates at a site still have room for `applicants` people. */
  async availability(query: AvailabilityQuery): Promise<Availability> {
    assertPositiveInt(query.siteId, 'siteId');
    const applicants = query.applicants ?? 1;
    assertApplicants(applicants);
    if (query.from !== undefined) assertDate(query.from, 'from');
    if (query.to !== undefined) assertDate(query.to, 'to');
    const session = await this.ensureSession(query.signal);
    const from = query.from ?? session.serverToday ?? todayIn('Asia/Manila');
    const to = query.to ?? session.maxDate ?? addDays(from, FALLBACK_HORIZON_DAYS);
    if (from > to) throw new RangeError(`from (${from}) is after to (${to})`);

    const key = `availability:${query.siteId}:${from}:${to}:${applicants}`;
    const { value, hit } = await this.cache.get(
      key,
      this.availabilityTtlMs,
      async (signal) => {
        const days = await this.postWithToken(
          ENDPOINTS.availability,
          { fromDate: from, toDate: to, siteId: query.siteId, requestedSlots: applicants },
          signal,
          { emptyMeansStaleSession: true },
          (text) => parseAvailability(parseJson(text, ENDPOINTS.availability), ENDPOINTS.availability),
        ).catch((err: unknown) => {
          if (err instanceof UpstreamError && err.status === 500) {
            throw new UpstreamError(
              `${err.message}; the site also answers 500 for an unknown siteId (${query.siteId}), see sites()`,
              err.status,
              err.url,
            );
          }
          throw err;
        });
        return summarise(query.siteId, from, to, applicants, days);
      },
      query.signal,
    );
    return { ...structuredClone(value as Availability), cached: hit };
  }

  /** Hourly slots on one date. Never selects or reserves a slot. */
  async timeSlots(query: TimeSlotQuery): Promise<TimeSlot[]> {
    assertPositiveInt(query.siteId, 'siteId');
    assertDate(query.date, 'date');
    const applicants = query.applicants ?? 1;
    assertApplicants(applicants);
    const { value } = await this.cache.get(
      `timeslots:${query.siteId}:${query.date}:${applicants}`,
      this.availabilityTtlMs,
      // An empty body is a legitimate "no slots published yet" answer here,
      // so only a reused session that has not proved good lately gets a second chance.
      (signal) =>
        this.postWithToken(
          ENDPOINTS.timeSlots,
          { preferredDate: query.date, siteId: query.siteId, requiredSlots: applicants },
          signal,
          { emptyMeansStaleSession: false },
          parseTimeSlots,
        ),
      query.signal,
    );
    return structuredClone(value as TimeSlot[]);
  }

  /**
   * Poll sites and yield what changed. Sites are checked one after another
   * through the same rate limiter; rate-limit errors are yielded, then
   * waited out, instead of being retried in a tight loop.
   */
  async *watch(opts: WatchOptions): AsyncGenerator<WatchEvent> {
    const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    if (intervalMs < MIN_WATCH_INTERVAL_MS) {
      throw new RangeError(`intervalMs must be at least ${MIN_WATCH_INTERVAL_MS}`);
    }
    const siteIds = [...new Set(opts.siteIds)];
    if (siteIds.length === 0) throw new RangeError('siteIds is empty');
    siteIds.forEach((id) => assertPositiveInt(id, 'siteId'));
    if (opts.applicants !== undefined) assertApplicants(opts.applicants);
    const budget = this.limits.maxRequestsPerHour;
    const perHour = Math.ceil(watchRequestsPerHour(siteIds.length, intervalMs));
    if (perHour > budget) {
      let minMs = MIN_WATCH_INTERVAL_MS;
      while (watchRequestsPerHour(siteIds.length, minMs) > budget) minMs += 60_000;
      throw new RangeError(
        `Watching ${siteIds.length} site(s) every ${Math.round(intervalMs / 1000)}s needs ~${perHour} requests/hour, ` +
          `over the budget of ${budget}. Use an interval of at least ${minMs / 60_000} min.`,
      );
    }

    const previous = new Map<number, Set<string>>();
    while (!opts.signal?.aborted) {
      for (const siteId of siteIds) {
        if (opts.signal?.aborted) return;
        try {
          const availability = await this.availability({
            siteId,
            ...(opts.applicants !== undefined && { applicants: opts.applicants }),
            ...(opts.from !== undefined && { from: opts.from }),
            ...(opts.to !== undefined && { to: opts.to }),
            ...(opts.signal !== undefined && { signal: opts.signal }),
          });
          const now = new Set(availability.availableDates);
          const before = previous.get(siteId);
          previous.set(siteId, now);
          yield {
            type: 'availability',
            siteId,
            availability,
            opened: before ? [...now].filter((d) => !before.has(d)) : [...now],
            closed: before ? [...before].filter((d) => !now.has(d)) : [],
            initial: before === undefined,
          };
        } catch (error) {
          if (opts.signal?.aborted) return;
          yield { type: 'error', siteId, error: error as Error };
          if (error instanceof RateLimitError) {
            await sleep(error.retryAfterMs, opts.signal).catch(() => undefined);
          }
        }
      }
      const jitter = Math.random() * 0.1 * intervalMs;
      await sleep(intervalMs + jitter, opts.signal).catch(() => undefined);
    }
  }

  /** Rate-limiter state for this host, e.g. for logging. */
  stats() {
    return this.gate.stats();
  }

  /**
   * Opens a session now if there is none, or the current one would lapse
   * within `withinMs` (default 2 minutes), so the next call does not wait for
   * one. One GET through the rate limiter, or nothing. True when it opened one.
   */
  async warmSession(opts: { withinMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const withinMs = opts.withinMs ?? 2 * 60 * 1000;
    if (!Number.isFinite(withinMs) || withinMs < 0) throw new RangeError('withinMs must be 0 or more');
    if (isFresh(this.session, Date.now() + withinMs)) return false;
    opts.signal?.throwIfAborted();
    const opening = !this.pendingSession;
    this.pendingSession ??= this.bootstrap().finally(() => {
      this.pendingSession = null;
    });
    await raceAbort(this.pendingSession, opts.signal);
    return opening;
  }

  private async postWithToken<T>(
    path: string,
    form: Form,
    signal: AbortSignal | undefined,
    { emptyMeansStaleSession }: { emptyMeansStaleSession: boolean },
    parse: (text: string) => T,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const reused = isFresh(this.session);
      const session = await this.ensureSession(signal);
      const result = await this.send('POST', path, { form, token: session.token, signal }, (text) =>
        text.trim() === '' ? EMPTY : parse(text),
      );
      const now = Date.now();
      session.lastUsedAt = now;
      if (result !== EMPTY) {
        session.confirmedAt = now;
        return result;
      }
      // The server answers a rejected anti-forgery token with an empty 200.
      const doubtful = reused && now - session.confirmedAt >= TOKEN_TRUSTED_MS;
      if (attempt === 0 && (emptyMeansStaleSession || doubtful)) {
        this.invalidateSession();
        continue;
      }
      if (emptyMeansStaleSession) {
        await this.gate.penalize();
        throw new SessionError(`${path} returned an empty body even with a new session`);
      }
      return parse('');
    }
  }

  /**
   * One bootstrap at a time, shared by concurrent callers. It is not tied to
   * any caller's signal, so one caller aborting cannot fail the others.
   */
  private ensureSession(signal?: AbortSignal): Promise<Session> {
    if (isFresh(this.session)) return Promise.resolve(this.session);
    // A caller who has already given up must not start a request nobody would wait for.
    signal?.throwIfAborted();
    this.pendingSession ??= this.bootstrap().finally(() => {
      this.pendingSession = null;
    });
    return raceAbort(this.pendingSession, signal);
  }

  private async bootstrap(): Promise<Session> {
    this.jar.clear();
    const page = await this.send(
      'GET',
      ENDPOINTS.bootstrap,
      { accept: 'text/html' },
      (text) => {
        const parsed = parseBootstrap(text);
        if (!parsed) {
          throw new SessionError(
            `No anti-forgery token on ${ENDPOINTS.bootstrap}; the site may have changed`,
          );
        }
        return parsed;
      },
    );
    const now = Date.now();
    this.session = { ...page, createdAt: now, lastUsedAt: now, confirmedAt: now };
    return this.session;
  }

  private invalidateSession() {
    this.session = null;
    this.jar.clear();
  }

  /**
   * One request through the rate limiter. `parse` runs inside the gated task,
   * so a response the package cannot read counts as a failure for backoff,
   * just like a non-2xx status.
   */
  private send<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { form?: Form; token?: string; signal?: AbortSignal | undefined; accept?: string },
    parse: (text: string) => T,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const gateOpts = { ...this.limits, maxWaitMs: this.maxWaitMs, signal: opts.signal };
    return this.gate.run(gateOpts, async (report) => {
      const headers = new Headers({
        'User-Agent': this.userAgent,
        Accept: opts.accept ?? 'application/json, text/html;q=0.9, */*;q=0.1',
      });
      const cookie = this.jar.header();
      if (cookie) headers.set('Cookie', cookie);
      let body: URLSearchParams | undefined;
      if (opts.form) {
        body = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.form)) body.set(k, String(v));
        headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
        headers.set('X-Requested-With', 'XMLHttpRequest');
      }
      if (opts.token) headers.set('__RequestVerificationToken', opts.token);

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          ...(body && { body }),
          signal,
          // A followed redirect would be a second request the limiter never saw,
          // possibly to another host. The site's endpoints never redirect.
          redirect: 'manual',
        });
        this.jar.store(res.headers);
        text = await res.text();
      } catch (err) {
        // The caller's own cancellation stays an AbortError; everything else
        // (timeout, DNS, refused connection) is the site being unreachable.
        if ((err as Error).name === 'AbortError') throw err;
        const cause = (err as Error & { cause?: Error }).cause?.message;
        throw new UpstreamError(
          `${method} ${path} failed: ${(err as Error).name === 'TimeoutError' ? `no answer within ${this.timeoutMs / 1000}s` : (cause ?? (err as Error).message)}`,
          0,
          url,
        );
      }

      if (!res.ok) {
        report({ ok: false, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) });
        const note = res.status >= 300 && res.status < 400 ? ' (a redirect, which is not followed)' : '';
        throw new UpstreamError(`${method} ${path} returned HTTP ${res.status}${note}`, res.status, url);
      }
      let value: T;
      try {
        value = parse(text);
      } catch (err) {
        report({ ok: false });
        throw err;
      }
      report({ ok: true });
      return value;
    });
  }
}

/**
 * Requests per hour a watch needs: one per site per round, plus session
 * refreshes (every round when rounds are further apart than the idle
 * timeout, otherwise once per maximum session age).
 */
function watchRequestsPerHour(sites: number, intervalMs: number): number {
  const rounds = HOUR_MS / intervalMs;
  const refreshes = intervalMs >= SESSION_IDLE_MS ? rounds : HOUR_MS / SESSION_MAX_AGE_MS;
  return rounds * sites + refreshes;
}

/**
 * The User-Agent every request carries: product/version, where to read about
 * it, and optionally how to reach whoever is running it.
 */
export function userAgent(contact?: string): string {
  return `${NAME}/${VERSION} (+${HOMEPAGE}; read-only availability checker${contact ? `; ${contact}` : ''})`;
}

function summarise(
  siteId: number,
  from: string,
  to: string,
  applicants: number,
  days: DayAvailability[],
): Availability {
  const availableDates = days.filter((d) => d.available).map((d) => d.date);
  return {
    siteId,
    from,
    to,
    applicants,
    earliest: availableDates[0] ?? null,
    availableDates,
    days,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
}

/** Printable ASCII, no parentheses: it sits inside the User-Agent's comment. */
export const CONTACT_RULE = 'contact must be printable ASCII, at most 200 characters, without ( or )';

export function assertContact(contact: string) {
  if (!/^[\x20-\x27\x2a-\x7e]{1,200}$/.test(contact)) throw new RangeError(CONTACT_RULE);
}

/** The DFA books one person, or a group of 2 to 5 ("Number of Applicants" on its group form). */
export const MAX_APPLICANTS = 5;

function assertApplicants(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_APPLICANTS) {
    throw new RangeError(`applicants must be 1 to ${MAX_APPLICANTS} (got ${value})`);
  }
}

function assertPositiveInt(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer (got ${value})`);
  }
}

function assertDate(value: string, name: string) {
  if (!isIsoDate(value)) throw new RangeError(`${name} must be a YYYY-MM-DD date (got ${value})`);
}

function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
