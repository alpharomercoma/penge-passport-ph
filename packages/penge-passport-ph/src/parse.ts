import { UpstreamError } from './errors.js';
import type { Country, DayAvailability, Site, TimeSlot } from './types.js';

// These parsers are the reference implementation: python/src/penge_passport_ph/parse.py
// follows them rule for rule, and both are pinned by test/fixtures/golden/. So
// nothing here leans on a regex engine's defaults: whitespace is the explicit
// set below (what JavaScript's \s means), word boundaries and case-folding are
// ASCII, and HTML is scanned in linear time so hostile input cannot hang it.

/** JavaScript's `\s`, spelled out so Python can use exactly the same set. */
export const WHITESPACE =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const WS = `[${WHITESPACE}]`;
/** Not preceded / not followed by an ASCII word character. */
const B = '(?<![A-Za-z0-9_])';
const E = '(?![A-Za-z0-9_])';

const CURRENT_DATE = new RegExp(`${B}currentDate${WS}*=${WS}*'([^']*)'`);
const MAX_DATE = new RegExp(`${B}MAX_DATE${WS}*=${WS}*'([^']*)'`);
const TOKEN_NAME = new RegExp(`${B}name${WS}*=${WS}*"__RequestVerificationToken"`, 'i');
const VALUE_ATTR = new RegExp(`${B}value${WS}*=${WS}*"([^"]*)"`, 'i');
const CLASS_ATTR = new RegExp(`${B}class${WS}*=${WS}*"([^"]*)"`, 'i');
const DISABLED = new RegExp(`${B}disabled${E}`, 'i');
/** Sticky: tried only at one offset, so each attempt costs its own length. */
const TIME_AT = new RegExp(`${WS}*([0-9]{1,2}:[0-9]{2})${WS}*-${WS}*([0-9]{1,2}:[0-9]{2})${WS}*`, 'y');
const REMAINING = new RegExp(`slots?${WS}*:${WS}*([0-9]+)`, 'i');
const SPACE_RUN = new RegExp(`${WS}+`, 'g');
const ENTITY = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(quot|apos|lt|gt|nbsp|amp));/g;
const NAMED: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0', amp: '&' };

/** .NET `TimeSpan` ticks per minute (1 tick = 100 ns). */
const TICKS_PER_MINUTE = 600_000_000;
/** 0001-01-01T00:00:00.000 and 9999-12-31T23:59:59.999, in epoch milliseconds. */
const MIN_DATE_MS = -62_135_596_800_000;
const MAX_DATE_MS = 253_402_300_799_999;

export interface BootstrapPage {
  token: string;
  /** The server's own "today" (`currentDate`), `YYYY-MM-DD`. */
  serverToday: string | null;
  /** Last bookable date the UI allows (`MAX_DATE`), `YYYY-MM-DD`. */
  maxDate: string | null;
}

export function parseBootstrap(html: string): BootstrapPage | null {
  const token = findTokenInput(html);
  if (!token) return null;
  return {
    token,
    serverToday: matchIsoDate(html, CURRENT_DATE),
    maxDate: matchIsoDate(html, MAX_DATE),
  };
}

function findTokenInput(html: string): string | null {
  for (const tag of openTags(html, asciiLower(html), 'input', 0)) {
    if (!TOKEN_NAME.test(tag.text)) continue;
    const value = VALUE_ATTR.exec(tag.text)?.[1];
    if (value) return value;
  }
  return null;
}

function matchIsoDate(html: string, pattern: RegExp): string | null {
  const value = pattern.exec(html)?.[1];
  return value && isIsoDate(value) ? value : null;
}

/**
 * JSON as the site sends it. `JSON.parse` already rejects NaN and Infinity;
 * the Python port rejects them explicitly to match.
 */
export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const snippet = trimWs(text.slice(0, 120).replace(SPACE_RUN, ' '));
    throw new UpstreamError(`${path} did not return JSON: "${snippet}"`, 200, path);
  }
}

export function parseCountries(body: unknown, url: string): Country[] {
  return expectArrayProp(body, 'Countries', url).map((c) => ({
    id: expectId(c.Id, url),
    name: name(c.Name),
  }));
}

export function parseSites(body: unknown, url: string): Site[] {
  return expectArrayProp(body, 'Sites', url).map((s) => ({
    id: expectId(s.Id, url),
    name: name(s.Name),
    description: text(s.Description),
    address: text(s.Address),
    telephone: text(s.Telephone),
    hours: text(s.Timeslots),
    mapUrl: text(s.Url),
    utcOffsetMinutes: utcOffset(s.Timezone),
  }));
}

/**
 * The site sends each date as epoch milliseconds for midnight UTC of that
 * calendar date, and its own script reads it back as a UTC date. So do we,
 * truncating fractions toward zero as `new Date()` does, for years 0001-9999.
 */
export function parseAvailability(body: unknown, url: string): DayAvailability[] {
  if (!Array.isArray(body)) {
    throw new UpstreamError('Availability response is not a JSON array', 200, url);
  }
  const days = body.map((item: unknown) => {
    const entry = isRecord(item) ? item : null;
    const ms = entry?.AppointmentDate;
    if (!entry || typeof ms !== 'number' || !Number.isFinite(ms) || typeof entry.IsAvailable !== 'boolean') {
      throw new UpstreamError('Availability entry has an unexpected shape', 200, url);
    }
    const whole = Math.trunc(ms);
    if (whole < MIN_DATE_MS || whole > MAX_DATE_MS) {
      throw new UpstreamError(`Availability date ${ms} is out of range`, 200, url);
    }
    return { date: new Date(whole).toISOString().slice(0, 10), available: entry.IsAvailable };
  });
  return days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Parse the HTML fragment `POST /appointment/timeslot` returns: one
 * `<label>…</label>` per hour. The internal slot ids are deliberately not
 * exposed: they only matter for reserving a slot, which this package does not do.
 */
export function parseTimeSlots(html: string): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (const block of elements(html, 'label')) {
    const lower = asciiLower(block);
    const input = openTags(block, lower, 'input', 0).next().value;
    const time = timeRange(block, lower);
    if (!input || !time) continue;
    const status = cleanText(contentOf(block, lower, (t) => hasClass(t.text, 'col-xs-5')) ?? '');
    const note = cleanText(contentOf(block, lower, (t) => hasClass(t.text, 'hidden')) ?? '');
    const remaining = REMAINING.exec(status)?.[1];
    slots.push({
      start: pad(time[0]),
      end: pad(time[1]),
      available: !DISABLED.test(input.text),
      remaining: remaining === undefined ? null : Math.min(Number(remaining), Number.MAX_SAFE_INTEGER),
      status,
      note: note || null,
    });
  }
  return slots;
}

/** A calendar date, `YYYY-MM-DD`, in years 0001-9999. */
export function isIsoDate(value: string): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1]!;
}

// -- linear-time HTML scanning ---------------------------------------------

interface Tag {
  /** The whole opening tag, `<name …>`. */
  text: string;
  /** True for a bare `<name>` with no attributes. */
  plain: boolean;
  /** Offset just after the tag's `>`. */
  end: number;
}

/** ASCII-only lower case, so offsets in the copy match the original. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * Opening tags `<name …>` from `from` on, ASCII case-insensitive, each ending
 * at the first `>`. Scanning resumes after each tag, so the work is linear.
 */
function* openTags(html: string, lower: string, name: string, from: number): Generator<Tag> {
  const needle = `<${name}`;
  for (;;) {
    const start = lower.indexOf(needle, from);
    if (start === -1) return;
    const after = start + needle.length;
    if (after < lower.length && /[a-z0-9_]/.test(lower[after]!)) {
      from = after;
      continue;
    }
    const close = lower.indexOf('>', after);
    if (close === -1) return;
    yield { text: html.slice(start, close + 1), plain: close === after, end: close + 1 };
    from = close + 1;
  }
}

/** The contents of each `<name …>…</name>` element, in order, without nesting. */
function* elements(html: string, name: string): Generator<string> {
  const lower = asciiLower(html);
  const closer = `</${name}>`;
  let from = 0;
  for (;;) {
    const tag = openTags(html, lower, name, from).next().value;
    if (!tag) return;
    const close = lower.indexOf(closer, tag.end);
    if (close === -1) return;
    yield html.slice(tag.end, close);
    from = close + closer.length;
  }
}

/** Content of the first `<span>` whose opening tag passes `accept`. */
function contentOf(html: string, lower: string, accept: (tag: Tag) => boolean): string | null {
  for (const tag of openTags(html, lower, 'span', 0)) {
    if (!accept(tag)) continue;
    const close = lower.indexOf('</span>', tag.end);
    return close === -1 ? null : html.slice(tag.end, close);
  }
  return null;
}

/** The first bare `<span>` whose whole content is `HH:MM-HH:MM`. */
function timeRange(html: string, lower: string): [string, string] | null {
  for (const tag of openTags(html, lower, 'span', 0)) {
    if (!tag.plain) continue;
    const close = lower.indexOf('</span>', tag.end);
    if (close === -1) return null;
    TIME_AT.lastIndex = tag.end;
    const m = TIME_AT.exec(html);
    if (m && TIME_AT.lastIndex === close) return [m[1]!, m[2]!];
  }
  return null;
}

function hasClass(tag: string, cls: string): boolean {
  const value = CLASS_ATTR.exec(tag)?.[1];
  return value !== undefined && value.split(SPACE_RUN).includes(cls);
}

/** Visible text: tags become spaces, entities are decoded, whitespace collapses. */
function cleanText(html: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = html.indexOf('<', i);
    if (open === -1) break;
    const close = html.indexOf('>', open);
    if (close === -1) break; // an unclosed '<' stays text, and so does the rest
    out += `${html.slice(i, open)} `;
    i = close + 1;
  }
  out += html.slice(i);
  return trimWs(decodeEntities(out).replace(SPACE_RUN, ' '));
}

/**
 * Numeric references and the few named ones the site uses, in one pass.
 * Code points that cannot be a character (0, surrogates, above U+10FFFF)
 * become U+FFFD, as HTML specifies.
 */
function decodeEntities(s: string): string {
  return s.replace(ENTITY, (_, dec?: string, hex?: string, named?: string) => {
    if (named) return NAMED[named]!;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(code);
  });
}

/** Trim the explicit whitespace set (a loop, not a regex: `\s+$` is quadratic). */
function trimWs(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && WHITESPACE.includes(s[start]!)) start++;
  while (end > start && WHITESPACE.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

function pad(hhmm: string): string {
  return hhmm.length === 4 ? `0${hhmm}` : hhmm;
}

function name(value: unknown): string {
  return typeof value === 'string' ? trimWs(value) : '';
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = trimWs(value.replace(/\r\n/g, '\n'));
  return t === '' ? null : t;
}

/** Minutes east of UTC from .NET ticks; null unless it is a real offset (within a day). */
function utcOffset(ticks: unknown): number | null {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks)) return null;
  const minutes = Math.round(ticks / TICKS_PER_MINUTE);
  return Math.abs(minutes) <= 24 * 60 ? minutes + 0 : null; // + 0 turns -0 into 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectArrayProp(body: unknown, prop: string, url: string): Record<string, unknown>[] {
  const list = isRecord(body) ? body[prop] : undefined;
  if (!Array.isArray(list)) {
    throw new UpstreamError(`Response has no "${prop}" array`, 200, url);
  }
  return list.map((item: unknown) => (isRecord(item) ? item : {}));
}

/** Ids are integers the site can round-trip: within ±(2^53 - 1). */
function expectId(value: unknown, url: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new UpstreamError('Expected an integer id', 200, url);
  }
  return value + 0;
}
