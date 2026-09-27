// What one checker run saw, as stored in R2 for later analysis, and the pure
// rules that decide whether a run can be trusted enough to email anyone.
import { isCalendarDate } from '@penge/contracts';
import type { DayAvailability } from 'penge-passport-ph';

export const SCAN_SCHEMA = 1;

export interface SiteObservation {
  id: number;
  name: string;
  /** As the DFA publishes them; shown when someone picks the office. */
  address: string | null;
  telephone: string | null;
  mapUrl: string | null;
  ok: boolean;
  error: string | null;
  from: string | null;
  to: string | null;
  /** Dates the site has opened for booking in the range, full or not. */
  publishedDays: number;
  /** Dates with room for one person. */
  openDates: string[];
  days: DayAvailability[];
  fetchedAt: string | null;
}

/** Extra lookups for group sizes that subscribers asked about. */
export interface GroupObservation {
  siteId: number;
  applicants: number;
  ok: boolean;
  error: string | null;
  openDates: string[];
}

export interface Scan {
  schema: typeof SCAN_SCHEMA;
  runId: string;
  startedAt: string;
  finishedAt: string;
  source: { host: string; client: string };
  healthy: boolean;
  problems: string[];
  sites: SiteObservation[];
  groups: GroupObservation[];
}

/** More failed sites than this, and the whole run is distrusted. */
export const MAX_FAILED_FRACTION = 0.2;

/**
 * A run is healthy only if it could be the truth: the site list loaded, most
 * sites answered, and at least one site publishes dates. Anything else looks
 * like an outage or a change on the site, and must not reach anyone's inbox.
 */
export function assessHealth(sitesLoaded: boolean, sites: SiteObservation[]): { healthy: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!sitesLoaded) problems.push('the site list did not load');
  else if (sites.length === 0) problems.push('the site list is empty');
  const failed = sites.filter((s) => !s.ok).length;
  if (sites.length > 0 && failed / sites.length > MAX_FAILED_FRACTION) {
    problems.push(`${failed} of ${sites.length} sites failed`);
  }
  if (sites.length > 0 && !sites.some((s) => s.ok && s.publishedDays > 0)) {
    problems.push('no site publishes any dates');
  }
  return { healthy: problems.length === 0, problems };
}

/** Dates in `now` that were not in `before`. Null when there is no baseline yet. */
export function newlyOpened(before: readonly string[] | undefined, now: readonly string[]): string[] | null {
  if (before === undefined) return null;
  const seen = new Set(before);
  return now.filter((d) => !seen.has(d)).sort();
}


/** A stored date list, or undefined if the value is missing or malformed. */
export function parseDates(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every(isCalendarDate)) return value as string[];
  } catch {
    // Treated as no baseline.
  }
  return undefined;
}
