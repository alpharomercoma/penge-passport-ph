// Details the checker does not collect: fresh dates, dates for a group size,
// and the hours of one day. Asked of passport.gov.ph only when someone opens an
// office or taps a day, then shared with everyone for 3 minutes. Their budget
// (LOOKUP_REQUESTS_PER_HOUR in budget.ts) is enforced by the library's rate
// limiter over any rolling hour, apart from the scans'.
import type { HourSlot, OfficeDates, OfficeTimes } from '@penge/contracts';
import { type Availability, RateLimitError, type TimeSlot } from 'penge-passport-ph';
import { K } from './keys.ts';
import type { Kv } from './kv.ts';
import type { Logger } from './log.ts';

export interface LookupUpstream {
  availability(query: { siteId: number; applicants: number }): Promise<Availability>;
  timeSlots(query: { siteId: number; date: string; applicants: number }): Promise<TimeSlot[]>;
}

/**
 * An answer is shared for 3 minutes: a busy office's dates change within
 * minutes, and this is what someone deciding to book looks at. An older
 * answer, up to an hour, is served only when the DFA cannot be asked.
 */
const FRESH_SECONDS = 180;
const KEEP_SECONDS = 3600;

/**
 * How recent an office's scan must be to answer for one person without asking
 * the DFA again. Scans start every 5 minutes and take about 2.5, so while they
 * keep up an office's scan is never older than this; asking anyway would only
 * hold up, behind the rate limiter's spacing, the hours the visitor taps next.
 */
export const SCAN_RECENT_SECONDS = 8 * 60;

export class LookupUnavailable extends Error {
  override name = 'LookupUnavailable';
}

interface Cached<T> {
  at: number;
  value: T;
}

export function createLookups(deps: { kv: Kv; upstream: LookupUpstream; log: Logger; now?: () => number }) {
  const { kv, upstream, log } = deps;
  const now = deps.now ?? Date.now;
  const inflight = new Map<string, Promise<unknown>>();

  async function cached<T>(key: string, fresh: number, fetch: () => Promise<T>): Promise<T> {
    const raw = await kv.get(key);
    const hitValue = raw ? (JSON.parse(raw) as Cached<T>) : null;
    if (hitValue && now() - hitValue.at < fresh * 1000) return hitValue.value;

    // Everyone asking for the same thing at once shares one request.
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const job = (async () => {
      try {
        const value = await fetch();
        await kv.set(key, JSON.stringify({ at: now(), value } satisfies Cached<T>), { ttlSeconds: KEEP_SECONDS });
        return value;
      } catch (err) {
        log.warn('lookup failed', { key, err: err as Error });
        if (hitValue) return hitValue.value;
        // The rate limiter refused: its hourly budget is spent, or it is resting after errors.
        if (err instanceof RateLimitError) {
          throw new LookupUnavailable(
            'We ask passport.gov.ph only so often, to keep the load on it light, and have asked enough for now. Try again in a few minutes.',
          );
        }
        throw new LookupUnavailable('passport.gov.ph did not answer. Try again in a few minutes.');
      }
    })();
    inflight.set(key, job);
    try {
      return await job;
    } finally {
      inflight.delete(key);
    }
  }

  const lookupKey = {
    dates: (siteId: number, applicants: number) => K.lookup(`dates:${siteId}:${applicants}`),
  };

  return {
    /** A stored answer, however old, without asking the DFA; null if there is none. */
    peekDates: async (siteId: number, applicants: number): Promise<OfficeDates | null> => {
      const raw = await kv.get(lookupKey.dates(siteId, applicants));
      return raw ? (JSON.parse(raw) as Cached<OfficeDates>).value : null;
    },
    dates: (siteId: number, applicants: number) =>
      cached<OfficeDates>(lookupKey.dates(siteId, applicants), FRESH_SECONDS, async () => {
        const a = await upstream.availability({ siteId, applicants });
        return {
          siteId,
          applicants,
          openDates: [...a.availableDates].sort(),
          fullDates: a.days.filter((d) => !d.available).map((d) => d.date).sort(),
          windowEnd: a.to,
          checkedAt: new Date(now()).toISOString(),
        };
      }),
    times: (siteId: number, date: string, applicants: number) =>
      cached<OfficeTimes>(K.lookup(`times:${siteId}:${date}:${applicants}`), FRESH_SECONDS, async () => {
        const slots = await upstream.timeSlots({ siteId, date, applicants });
        return {
          siteId,
          date,
          applicants,
          slots: slots.map((s): HourSlot => ({ start: s.start, end: s.end, available: s.available, remaining: s.remaining })),
          checkedAt: new Date(now()).toISOString(),
        };
      }),
  };
}

export type Lookups = ReturnType<typeof createLookups>;
