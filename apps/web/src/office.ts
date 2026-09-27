// Turning the checker's status into what the page shows: offices with a place
// and a detail line, sorted and searchable, and dates and hours as words.
import { type AbroadPost, describePost, LIMITS, officeMapUrl, officePhone, type SiteStatus } from '@penge/contracts';
import { areaOf } from './areas.ts';

export interface Office {
  id: number;
  /** Full name as the DFA publishes it. */
  name: string;
  /** "Antipolo" */
  place: string;
  /** "SM Center, Antipolo City, Rizal"; abroad, "Philippine Embassy, Denmark" */
  detail: string;
  /** NCR, Luzon, Visayas or Mindanao at home; the DFA's region abroad ("Europe"). */
  area: string;
  /** Abroad only: the country the post is in. */
  country: string | null;
  address: string | null;
  telephone: string | null;
  mapUrl: string | null;
  ok: boolean;
  /** When these dates were read; older than the last scan when this office's latest check failed. */
  checkedAt: string | null;
  openDates: string[];
  /** Released dates with no room left. */
  fullDates: string[];
  /** Last date of the booking window. */
  windowEnd: string | null;
  publishedDays: number;
  earliest: string | null;
}

export type SortMode = 'soonest' | 'name';

const tidy = (s: string) =>
  s
    .replace(/\s*,[\s,]*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/[\s,-]+$/, '')
    .trim();

/** Words in all capitals ("ROBINSONS GALLERIA") read better in title case. */
const unshout = (s: string) =>
  (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()))
    // The mall chain is "SM" however the source spells it.
    .replace(/\bSm\b/g, 'SM');

/** "Cebu (ROBINSONS GALLERIA , CEBU CITY )" → { place: "Cebu", detail: "Robinsons Galleria, Cebu City" } */
export function splitName(name: string): { place: string; detail: string } {
  const open = name.indexOf('(');
  if (open <= 0) return { place: tidy(name), detail: '' };
  const close = name.lastIndexOf(')');
  const place = tidy(name.slice(0, open));
  const detail = tidy(unshout(name.slice(open + 1, close > open ? close : undefined)));
  return { place: place || tidy(name), detail };
}

function facts(s: SiteStatus) {
  const dates = [...s.openDates].sort();
  return {
    id: s.id,
    name: s.name,
    address: s.address?.replace(/\s+/g, ' ').trim() || null,
    telephone: officePhone(s.telephone),
    mapUrl: officeMapUrl(s.mapUrl),
    ok: s.ok,
    checkedAt: s.checkedAt ?? null,
    openDates: dates,
    fullDates: [...(s.fullDates ?? [])].sort(),
    windowEnd: s.windowEnd ?? null,
    publishedDays: s.publishedDays,
    earliest: dates[0] ?? null,
  };
}

export function toOffices(sites: SiteStatus[]): Office[] {
  return sites.map((s) => {
    const parts = splitName(s.name);
    return { ...facts(s), ...parts, area: areaOf(parts.place), country: null };
  });
}

/** Posts abroad: "PE Copenhagen" in Denmark reads as Copenhagen, Philippine Embassy, Denmark. */
export function toAbroadOffices(posts: AbroadPost[]): Office[] {
  return posts.map((p) => {
    const { place, detail } = describePost(p.name, p.country);
    return { ...facts(p), place, detail, area: p.region, country: p.country };
  });
}

export function sortOffices(offices: Office[], mode: SortMode): Office[] {
  const byPlace = (a: Office, b: Office) => a.place.localeCompare(b.place);
  if (mode === 'name') return [...offices].sort(byPlace);
  return [...offices].sort((a, b) => {
    if (a.earliest && b.earliest) return a.earliest.localeCompare(b.earliest) || byPlace(a, b);
    if (a.earliest) return -1;
    if (b.earliest) return 1;
    return byPlace(a, b);
  });
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Matches the place, the mall or the city; accents optional ("dasmarinas" finds Dasmariñas). */
export function matches(office: Office, query: string): boolean {
  const q = fold(query.trim());
  return !q || fold(`${office.place} ${office.detail} ${office.name}`).includes(q);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const parse = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
};

/** "2026-10-01" → "Thu 1 Oct" */
export function shortDate(date: string): string {
  const { m, d, weekday } = parse(date);
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}

/** "08:00", "09:00" → "8:00 to 9:00 AM"; "11:00", "13:00" → "11:00 AM to 1:00 PM" */
export function hourRange(start: string, end: string): string {
  const to12 = (t: string) => {
    const [h, m] = t.split(':').map(Number) as [number, number];
    return { text: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`, pm: h >= 12 };
  };
  const a = to12(start);
  const b = to12(end);
  const suffix = (pm: boolean) => (pm ? 'PM' : 'AM');
  return a.pm === b.pm ? `${a.text} to ${b.text} ${suffix(b.pm)}` : `${a.text} ${suffix(a.pm)} to ${b.text} ${suffix(b.pm)}`;
}

/** Today's date in Manila, YYYY-MM-DD. */
export function manilaToday(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The choices the DFA offers: one person, or a group of 2 to 5. */
export const PARTY_SIZES = Array.from({ length: LIMITS.maxApplicants }, (_, i) => i + 1);
export const partyLabel = (n: number) => (n === 1 ? 'Just me' : `${n} people`);
