// Rules the website and the server must agree on. The website uses them to
// give instant feedback; the server applies them again, because anything a
// browser sends can be forged. test/fuzz.test.ts attacks every function here.

export const LIMITS = Object.freeze({
  /** RFC 5321's practical ceiling for a whole address. */
  emailMaxLength: 254,
  emailLocalMaxLength: 64,
  sitesPerSubscription: 10,
  /** People in one booking: the DFA books one person, or a group of 2 to 5. */
  maxApplicants: 5,
});

/**
 * How often one person may be emailed. Either way each email carries everything
 * new since the last, and dates that closed in between are left out.
 */
export const PACES = ['hourly', 'asap'] as const;
export type Pace = (typeof PACES)[number];
export const isPace = (v: unknown): v is Pace => (PACES as readonly unknown[]).includes(v);
export const PACE_LABELS: Record<Pace, string> = {
  hourly: 'At most once an hour',
  asap: 'As soon as a check finds dates',
};

export type PushMode = 'off' | 'owner' | 'live';
export const isPushMode = (v: unknown): v is PushMode => v === 'off' || v === 'owner' || v === 'live';

export interface SubscribeRequest {
  email: string;
  siteIds: number[];
  applicants: number;
  pace: Pace;
}

export type Field = 'email' | 'siteIds' | 'applicants' | 'pace' | 'form';

export type Checked<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Partial<Record<Field, string>> };

/** Allowed in the local part: RFC 5322 "atext" and dots. No quoted strings, no spaces. */
const LOCAL_CHARS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;

/**
 * Lower-cased, trimmed address, or null if it is not one we will send to.
 * Deliberately stricter than RFC 5322: ASCII only (internationalised
 * domains must be given in their xn-- form), no IP-literal domains, no
 * quoted local parts. Nothing that could smuggle a header or a second
 * recipient survives.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > LIMITS.emailMaxLength) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || email.indexOf('@') !== at) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > LIMITS.emailLocalMaxLength || !LOCAL_CHARS.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || domain.length > 253) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  if (!TLD.test(labels.at(-1)!)) return null;
  return email;
}

export interface AlertChoices {
  siteIds: number[];
  applicants: number;
  pace: Pace;
}

/**
 * Offices, group size and pace, as both kinds of alert take them. `knownSiteIds` is the server's current site
 * list; without it (in the browser) only the shape of the ids is checked.
 */
export function validateChoices(input: unknown, knownSiteIds?: ReadonlySet<number>): Checked<AlertChoices> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: { form: 'Send the form as a JSON object.' } };
  const body = input as Record<string, unknown>;
  const errors: Partial<Record<Field, string>> = {};
  const siteIds: number[] = [];
  if (!Array.isArray(body.siteIds) || body.siteIds.length === 0) {
    errors.siteIds = 'Choose at least one site.';
  } else if (body.siteIds.length > LIMITS.sitesPerSubscription * 4) {
    errors.siteIds = `Choose at most ${LIMITS.sitesPerSubscription} sites.`;
  } else {
    for (const id of body.siteIds) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
        errors.siteIds = 'That site list is not valid.';
        break;
      }
      if (knownSiteIds && !knownSiteIds.has(id)) {
        errors.siteIds = 'One of those sites is not on the list.';
        break;
      }
      if (!siteIds.includes(id)) siteIds.push(id);
    }
    if (!errors.siteIds && siteIds.length > LIMITS.sitesPerSubscription) errors.siteIds = `Choose at most ${LIMITS.sitesPerSubscription} sites.`;
  }
  const applicants = body.applicants === undefined ? 1 : body.applicants;
  if (typeof applicants !== 'number' || !Number.isInteger(applicants) || applicants < 1 || applicants > LIMITS.maxApplicants) {
    errors.applicants = `Choose from 1 to ${LIMITS.maxApplicants} people.`;
  }
  const pace = body.pace === undefined ? 'hourly' : body.pace;
  if (!isPace(pace)) errors.pace = 'Choose how often to get alerts.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { siteIds: siteIds.sort((a, b) => a - b), applicants: applicants as number, pace: pace as Pace } };
}

/**
 * Check a subscription request. `knownSiteIds` is the server's current site
 * list; without it (in the browser) only the shape of the ids is checked.
 */
export function validateSubscribe(
  input: unknown,
  knownSiteIds?: ReadonlySet<number>,
): Checked<SubscribeRequest> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: { form: 'Send the form as a JSON object.' } };
  }
  const body = input as Record<string, unknown>;
  const errors: Partial<Record<Field, string>> = {};

  // A field real people never see or fill: bots do.
  if (body.website !== undefined && body.website !== '') {
    return { ok: false, errors: { form: 'The form could not be sent.' } };
  }

  const email = normalizeEmail(body.email);
  if (!email) errors.email = 'Enter a valid email address, like juan@example.com.';

  const choices = validateChoices(body, knownSiteIds);
  if (!choices.ok) Object.assign(errors, choices.errors);

  // Both checks reported together; the explicit branch narrows `choices` for TypeScript.
  if (Object.keys(errors).length > 0 || !choices.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      email: email!,
      siteIds: choices.value.siteIds,
      applicants: choices.value.applicants,
      pace: choices.value.pace,
    },
  };
}

/** Tokens in links are 32 random bytes, base64url: exactly 43 characters. */
export function isToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw);
}

/** Unsubscribe links carry `<subscriber id>.<signature>`. */
export function isUnsubscribeToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{43}$/.test(raw);
}

// -- API shapes ---------------------------------------------------------------

export interface SiteSummary {
  id: number;
  name: string;
}

export interface SiteStatus {
  id: number;
  name: string;
  /** As the DFA shows them when an office is picked (absent in older data). */
  address?: string | null;
  /** Checked with officePhone and officeMapUrl before they are stored. */
  telephone?: string | null;
  mapUrl?: string | null;
  /**
   * When this office's dates were read. Older than the scan when its latest
   * check failed and it shows what was known before (absent in older data).
   */
  checkedAt?: string | null;
  ok: boolean;
  openDates: string[];
  /** Released dates with no room left (absent in older data). */
  fullDates?: string[];
  /** The last date of the DFA's booking window; dates up to it may still be released. */
  windowEnd?: string | null;
  publishedDays: number;
}

export interface StatusResponse {
  /** When the checker last ran, successfully or not. */
  checkedAt: string | null;
  /** When the data in `sites` was collected: the last run that passed every check. */
  lastHealthyAt: string | null;
  /** False when the last run failed its checks; `sites` then shows older data. */
  healthy: boolean;
  /** False while emails are not being sent (before the mail domain is set up). */
  mailLive: boolean;
  sites: SiteStatus[];
  /** Whether push can be turned on: off, only for the owner's test addresses, or for everyone. */
  push: PushMode;
  /** The VAPID public key browsers subscribe with; null when push is off. */
  vapidPublicKey: string | null;
}

/** A post abroad (embassy, consulate, or one of their outreach missions) and what its latest check saw. */
export interface AbroadPost extends SiteStatus {
  /** The DFA's region: 1 Asia Pacific, 2 Europe, 3 North America, 4 South America, 5 Middle East/Africa. */
  regionId: number;
  region: string;
  countryId: number;
  country: string;
}

export interface AbroadResponse {
  /** When the list of posts was last read in full from the DFA. */
  catalogAt: string | null;
  /** How often a post that publishes dates is checked, in minutes. */
  checkedEveryMinutes: number;
  posts: AbroadPost[];
}

export interface ApiError {
  error: string;
  fields?: Partial<Record<Field, string>>;
  /** reload: an old page; push-unavailable: push could not be turned on and email is off; full: 5 devices already. */
  code?: 'reload' | 'limited';
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Base64url (padding allowed) of exactly `n` bytes. */
function isB64urlOf(s: unknown, n: number): s is string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return false;
  const clean = s.replace(/=+$/, '');
  return clean.length === Math.ceil((n * 8) / 6);
}

/** PushSubscription.toJSON(), checked for shape only. The server checks the host and the key. */
export function parsePushSubscription(raw: unknown): PushSubscriptionInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (typeof r.endpoint !== 'string' || r.endpoint.length > 1024 || !r.endpoint.startsWith('https://')) return null;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (!isB64urlOf(p256dh, 65) || !isB64urlOf(auth, 16)) return null;
  return { endpoint: r.endpoint, p256dh: p256dh.replace(/=+$/, ''), auth: auth.replace(/=+$/, '') };
}

export interface SubscribeResponse {
  message: string;
}

export interface ConfirmResponse {
  status: 'confirmed' | 'updated';
  siteIds: number[];
  applicants: number;
  pace: Pace;
  /** Only pages of the channel release read this; the server still sends it for them. */
  channels?: { emailOn: boolean; pushOn: boolean; push: string };
}

// -- Display helpers shared by the emails and the website ---------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-05" → "Mon 5 Oct 2026", the same everywhere (no locale data involved). */
export function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(d.getTime())) return date;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Antipolo (SM Center, Antipolo City, Rizal)" → "Antipolo". */
export function shortName(name: string): string {
  const cut = name.indexOf('(');
  const short = (cut > 0 ? name.slice(0, cut) : name).replace(/[\s,-]+$/, '').trim();
  return short || name.trim();
}

const POST_KINDS: Record<string, string> = {
  PE: 'Philippine Embassy',
  PCG: 'Philippine Consulate General',
  MECO: 'Manila Economic and Cultural Office',
};

/**
 * A post abroad in words: "PE Copenhagen", "Denmark" → place "Copenhagen",
 * detail "Philippine Embassy, Denmark". An outreach mission is named for where
 * it goes: "PE Tokyo - Outreach in Okinawa 2026" → "Okinawa 2026", run by the
 * embassy in Tokyo.
 */
export function describePost(name: string, country: string): { place: string; detail: string; outreach: boolean } {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const [head = '', ...rest] = clean(name).split(/\s+-\s+/);
  const [prefix = '', ...city] = head.split(' ');
  const kind = POST_KINDS[prefix];
  const base = kind ? clean(city.join(' ')) || head : head;
  const where = clean(country);
  if (rest.length === 0) {
    return { place: base, detail: kind ? `${kind}, ${where}` : where, outreach: false };
  }
  // "Outreach Mission 01 (For Dar es Salaam, Tanzania)", "Consular Mission in
  // Vladivostok", "Kristiansand Consular Outreach": keep only the place.
  let place = clean(rest.join(' - '));
  const inside = /\(\s*for\s+([^)]+)\)/i.exec(place);
  if (inside) place = inside[1]!;
  place = clean(
    place
      .replace(/^(?:consular\s+)?(?:outreach|mission)(?:\s+mission)?(?:\s+\d+)?(?:\s+(?:in|for))?\s*/i, '')
      .replace(/\s+consular\s+outreach$/i, '')
      .replace(/^-\s*/, ''),
  );
  return {
    place: place || base,
    detail: `Outreach by the ${kind ?? head} in ${base}, ${where}`,
    outreach: true,
  };
}

/** "2026-10-05" and a real day of the calendar (2026-09-31 is not one). */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The office's contact number, or null for the placeholders ("0000") some offices list. */
export function officePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const phone = raw.trim();
  return phone.length <= 60 && /[1-9]/.test(phone) ? phone : null;
}

const MAP_LINKS: Record<string, RegExp> = {
  'www.google.com': /^\/(maps|search)\b/,
  'www.google.com.ph': /^\/(maps|search)\b/,
  'maps.google.com': /^\//,
  'maps.app.goo.gl': /^\//,
  'goo.gl': /^\/maps\b/,
};

/** An https Google Maps link, or null: one office lists its address in the link field. */
export function officeMapUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 1000) return null;
  try {
    const url = new URL(raw.trim());
    const path = MAP_LINKS[url.hostname];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && path?.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

// -- Response guards: the website trusts nothing it did not check -------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isDate = isCalendarDate;
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

function isSiteStatus(s: unknown): s is SiteStatus {
  return (
    isObject(s) &&
    isId(s.id) &&
    isName(s.name) &&
    (s.address === undefined || s.address === null || (typeof s.address === 'string' && s.address.length <= 400)) &&
    (s.telephone === undefined || s.telephone === null || officePhone(s.telephone) === s.telephone) &&
    (s.mapUrl === undefined || s.mapUrl === null || officeMapUrl(s.mapUrl) === s.mapUrl) &&
    (s.checkedAt === undefined || s.checkedAt === null || isIso(s.checkedAt)) &&
    (s.fullDates === undefined || (Array.isArray(s.fullDates) && s.fullDates.length <= 1000 && s.fullDates.every(isDate))) &&
    (s.windowEnd === undefined || s.windowEnd === null || isDate(s.windowEnd)) &&
    typeof s.ok === 'boolean' &&
    Array.isArray(s.openDates) &&
    s.openDates.length <= 1000 &&
    s.openDates.every(isDate) &&
    typeof s.publishedDays === 'number' &&
    Number.isSafeInteger(s.publishedDays) &&
    s.publishedDays >= 0
  );
}

export function isStatusResponse(v: unknown): v is StatusResponse {
  if (!isObject(v)) return false;
  // A server from before push says nothing about it: that is push off.
  // Reflect.set answers false, rather than throwing, on an object that cannot take the field.
  if (v.push === undefined && !Reflect.set(v, 'push', 'off')) return false;
  if (v.vapidPublicKey === undefined && !Reflect.set(v, 'vapidPublicKey', null)) return false;
  if (!isPushMode(v.push) || (v.vapidPublicKey !== null && typeof v.vapidPublicKey !== 'string')) return false;
  return (
    (v.checkedAt === null || isIso(v.checkedAt)) &&
    (v.lastHealthyAt === null || isIso(v.lastHealthyAt)) &&
    typeof v.healthy === 'boolean' &&
    typeof v.mailLive === 'boolean' &&
    Array.isArray(v.sites) &&
    v.sites.length <= 500 &&
    v.sites.every(isSiteStatus)
  );
}

export function isAbroadResponse(v: unknown): v is AbroadResponse {
  return (
    isObject(v) &&
    (v.catalogAt === null || isIso(v.catalogAt)) &&
    typeof v.checkedEveryMinutes === 'number' &&
    Number.isSafeInteger(v.checkedEveryMinutes) &&
    v.checkedEveryMinutes > 0 &&
    Array.isArray(v.posts) &&
    v.posts.length <= 1000 &&
    v.posts.every(
      (p) =>
        isObject(p) &&
        isId(p.regionId) &&
        isName(p.region) &&
        isId(p.countryId) &&
        isName(p.country) &&
        isSiteStatus(p),
    )
  );
}

// -- Details looked up on demand when someone opens an office ---------------

/** Open dates at one office for a group size. */
export interface OfficeDates {
  siteId: number;
  applicants: number;
  openDates: string[];
  fullDates: string[];
  windowEnd: string | null;
  /** When the DFA was asked. */
  checkedAt: string;
  /** A refresh failed; checkedAt still belongs to the saved observation. */
  warning?: string;
}

/** One hour on one day, as the DFA shows it. `remaining` is given for some hours only ("Available Slots: 20"). */
export interface HourSlot {
  start: string;
  end: string;
  available: boolean;
  remaining: number | null;
}

export interface OfficeTimes {
  siteId: number;
  date: string;
  applicants: number;
  slots: HourSlot[];
  checkedAt: string;
  warning?: string;
}

const isHHMM = (v: unknown): v is string => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
const isCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000;
const isApplicants = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= LIMITS.maxApplicants;

export function isOfficeDates(v: unknown): v is OfficeDates {
  return (
    isObject(v) &&
    isId(v.siteId) &&
    isApplicants(v.applicants) &&
    Array.isArray(v.openDates) &&
    v.openDates.length <= 1000 &&
    v.openDates.every(isDate) &&
    Array.isArray(v.fullDates) &&
    v.fullDates.length <= 1000 &&
    v.fullDates.every(isDate) &&
    (v.windowEnd === null || isDate(v.windowEnd)) &&
    isIso(v.checkedAt) &&
    (v.warning === undefined || (typeof v.warning === 'string' && v.warning.length > 0 && v.warning.length <= 300))
  );
}

export function isOfficeTimes(v: unknown): v is OfficeTimes {
  return (
    isObject(v) &&
    isId(v.siteId) &&
    isDate(v.date) &&
    isApplicants(v.applicants) &&
    isIso(v.checkedAt) &&
    (v.warning === undefined || (typeof v.warning === 'string' && v.warning.length > 0 && v.warning.length <= 300)) &&
    Array.isArray(v.slots) &&
    v.slots.length <= 48 &&
    v.slots.every(
      (s) =>
        isObject(s) &&
        isHHMM(s.start) &&
        isHHMM(s.end) &&
        typeof s.available === 'boolean' &&
        (s.remaining === null || isCount(s.remaining)),
    )
  );
}

// -- Notification alerts on a device (deviceAlerts: 1) -------------------------

export const DEVICE_ALERTS_VERSION = 1;
/** An alert lasts this long after setup or the last opening that reached the server. */
export const DEVICE_ALERT_DAYS = 180;
/** A setup or rotation must be acknowledged within this. */
export const SETUP_SECONDS = 300;

const B64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const isOpId = (v: unknown): v is string => typeof v === 'string' && B64URL_22.test(v);
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
// Not `isCount` (index.ts already has one, bounded at 10,000 slots): any non-negative safe integer.
const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** The subscription as both sides hash it for its fingerprint: endpoint and unpadded keys, in this order. */
export function canonicalSubscription(s: PushSubscriptionInput): string {
  return JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.p256dh.replace(/=+$/, ''), auth: s.auth.replace(/=+$/, '') } });
}

export interface CapturedAlert {
  incarnation: string;
  generation: number;
  revision: number;
}

export interface Activation {
  alertId: string;
  incarnation: string;
  generation: number;
  revision: number;
}

export type OperationKind = 'setup' | 'change' | 'rotate';
export type DispatchState = 'unsent' | 'sending' | 'accepted' | 'uncertain' | 'retryable' | 'failed';
export type TerminalResult = 'active' | 'expired' | 'changed' | 'full' | 'owner-only' | 'gone' | 'failed';
export const TERMINAL_RESULTS: readonly TerminalResult[] = ['active', 'expired', 'changed', 'full', 'owner-only', 'gone', 'failed'];

export interface OperationView {
  op: string;
  seq: number;
  kind: OperationKind;
  /** ISO; null for a change, which never waits. */
  expiresAt: string | null;
  dispatch: DispatchState | null;
  /** ISO: the earliest time the driving page may repeat the request, while unsent or retryable. */
  retryAt: string | null;
  /** expiresAt and retryAt as milliseconds from the server's now: the device turns them into its own times on arrival,
   * so a device clock that is wrong neither expires an admitted setup nor repeats it early. */
  remainingMs: number | null;
  retryInMs: number | null;
  /** Why the push was not sent yet: paused, backoff, limited, mode. */
  reason: 'paused' | 'backoff' | 'limited' | 'mode' | null;
  result: TerminalResult | null;
  activation: Activation | null;
}

export interface DeviceAlertView {
  alertId: string;
  incarnation: string;
  generation: number;
  revision: number;
  choices: AlertChoices;
  fingerprint: string;
  endsAt: string;
  /** The old subscription was reported gone while a rotation is pending. */
  updating: boolean;
}

export type MineState =
  | { state: 'active'; alert: DeviceAlertView }
  | { state: 'ended'; endedAt: string }
  | { state: 'gone'; endedAt: string; fingerprint: string }
  | { state: 'none' };
export type MineAnswer = MineState & { operation: OperationView | null };

export type SetupOutcome = 'pending' | 'done' | 'busy' | 'limited' | 'full' | 'invalid' | 'owner-only' | 'off' | 'unavailable' | 'changed';
export interface SetupAnswer {
  outcome: SetupOutcome;
  operation: OperationView | null;
}
export type ReadyResult = TerminalResult | 'invalid' | 'unknown';
export interface ReadyAnswer {
  result: ReadyResult;
  activation: Activation | null;
}
export type ChangeAnswer = { result: 'active'; revision: number } | { result: 'changed' | 'busy' | 'invalid' | 'full' };
export type SeenAnswer = { state: 'active'; endsAt: string } | { state: 'ended' | 'none' };
export type TestOutcome = 'accepted' | 'uncertain' | 'refused' | 'gone' | 'unavailable' | 'limited' | 'none';
export interface TestAnswer {
  test: TestOutcome;
  /** For gone: the alert was kept while its rotation finishes ("Updating this device's notifications…"). */
  updating?: boolean;
}

export interface SetupRequest {
  op: string;
  seq: number;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  choices: AlertChoices;
  captured: CapturedAlert | null;
}
export interface RotateRequest {
  op: string;
  seq: number;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  captured: { incarnation: string; generation: number };
}
export interface ChangeRequest {
  op: string;
  seq: number;
  incarnation: string;
  baseRevision: number;
  choices: AlertChoices;
}
export interface ReadyRequest {
  op: string;
  nonce: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// All three named: validateChoices' defaults are the email form's, never a device's.
const isChoices = (v: unknown) => isObj(v) && only(v, ['siteIds', 'applicants', 'pace']) && 'siteIds' in v && 'applicants' in v && 'pace' in v && validateChoices(v).ok;
// PushSubscription.toJSON() exactly: nothing else rides along, and no control character the server's checks would read differently.
const isDeviceSubscription = (v: unknown) =>
  isObj(v) &&
  only(v, ['endpoint', 'keys', 'expirationTime']) &&
  (v.expirationTime === undefined || v.expirationTime === null || isNonNegative(v.expirationTime)) &&
  isObj(v.keys) &&
  only(v.keys, ['p256dh', 'auth']) &&
  typeof v.endpoint === 'string' &&
  !/[\u0000-\u001f\u007f]/.test(v.endpoint) &&
  parsePushSubscription(v) !== null;

export function isSetupRequest(v: unknown): v is SetupRequest {
  if (!isObj(v) || !only(v, ['op', 'seq', 'subscription', 'choices', 'captured'])) return false;
  const c = v.captured;
  const captured = c === null || (isObj(c) && only(c, ['incarnation', 'generation', 'revision']) && isOpId(c.incarnation) && isSeq(c.generation) && isSeq(c.revision));
  return isOpId(v.op) && isSeq(v.seq) && isDeviceSubscription(v.subscription) && isChoices(v.choices) && captured;
}

export function isRotateRequest(v: unknown): v is RotateRequest {
  if (!isObj(v) || !only(v, ['op', 'seq', 'subscription', 'captured'])) return false;
  const c = v.captured;
  return isOpId(v.op) && isSeq(v.seq) && isDeviceSubscription(v.subscription) && isObj(c) && only(c, ['incarnation', 'generation']) && isOpId(c.incarnation) && isSeq(c.generation);
}

export function isChangeRequest(v: unknown): v is ChangeRequest {
  return isObj(v) && only(v, ['op', 'seq', 'incarnation', 'baseRevision', 'choices']) && isOpId(v.op) && isSeq(v.seq) && isOpId(v.incarnation) && isSeq(v.baseRevision) && isChoices(v.choices);
}

export function isReadyRequest(v: unknown): v is ReadyRequest {
  return isObj(v) && only(v, ['op', 'nonce']) && isOpId(v.op) && typeof v.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.nonce);
}

// What toISOString() writes, and only that: a February 30th or a 24:00 reads back as another day.
const isServerTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isIsoOrNull = (v: unknown) => v === null || isServerTime(v);
const isFingerprint = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

function isActivation(v: unknown): v is Activation {
  return isObj(v) && isOpId(v.alertId) && isOpId(v.incarnation) && isSeq(v.generation) && isSeq(v.revision);
}

export function isOperationView(v: unknown): v is OperationView {
  return (
    isObj(v) &&
    isOpId(v.op) &&
    isSeq(v.seq) &&
    (v.kind === 'setup' || v.kind === 'change' || v.kind === 'rotate') &&
    isIsoOrNull(v.expiresAt) &&
    (v.dispatch === null || ['unsent', 'sending', 'accepted', 'uncertain', 'retryable', 'failed'].includes(v.dispatch as string)) &&
    isIsoOrNull(v.retryAt) &&
    (v.remainingMs === null || (typeof v.remainingMs === 'number' && Number.isSafeInteger(v.remainingMs) && v.remainingMs >= 0)) &&
    (v.retryInMs === null || (typeof v.retryInMs === 'number' && Number.isSafeInteger(v.retryInMs) && v.retryInMs >= 0)) &&
    (v.reason === null || ['paused', 'backoff', 'limited', 'mode'].includes(v.reason as string)) &&
    (v.result === null || (TERMINAL_RESULTS as readonly unknown[]).includes(v.result)) &&
    (v.activation === null || isActivation(v.activation)) &&
    // Each time and its relative twin come and go together; a change never waits, a setup or rotation always expires.
    (v.expiresAt === null) === (v.remainingMs === null) &&
    (v.retryAt === null) === (v.retryInMs === null) &&
    (v.kind === 'change' ? v.expiresAt === null : v.expiresAt !== null)
  );
}

export function isMineAnswer(v: unknown): v is MineAnswer {
  if (!isObj(v) || !(v.operation === null || isOperationView(v.operation))) return false;
  if (v.state === 'none') return true;
  if (v.state === 'ended') return isServerTime(v.endedAt);
  if (v.state === 'gone') return isServerTime(v.endedAt) && isFingerprint(v.fingerprint);
  if (v.state !== 'active' || !isObj(v.alert)) return false;
  const a = v.alert;
  return isActivation(a) && isChoices(a.choices) && isFingerprint(a.fingerprint) && isServerTime(a.endsAt) && typeof a.updating === 'boolean' && isNonNegative(a.generation);
}
