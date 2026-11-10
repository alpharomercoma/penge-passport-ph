// Gmail takes only so many of our emails a day (deploy/README.md, "When Gmail rate-limits the domain"):
// past that it refuses every one (421 4.7.28) until its day turns over, which it has done a little
// after 02:00 UTC each day we watched. Handing it more only wastes the alerts and keeps the limit on.
// So the checker counts the alerts it sends to Gmail addresses and stops at GMAIL_DAILY_LIMIT; an alert
// that would pass it waits like one held for a person's pace, and everyone else is emailed as usual.

/** When Gmail's day starts, after midnight UTC: 02:10, a little after the allowance has been seen to return. */
export const GMAIL_DAY_OFFSET_MS = (2 * 60 + 10) * 60_000;
const DAY_MS = 24 * 3600_000;
/** This much of the day's limit may go at once when the day starts; the rest is released evenly until it ends. */
export const GMAIL_HEAD_START = 0.25;

/** Addresses Gmail's own servers receive for (not Google Workspace domains, which it has not limited). */
export function isGmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase();
  return domain === 'gmail.com' || domain === 'googlemail.com';
}

/** The Gmail day a moment falls in, named by the UTC date it started on. */
export function gmailDay(now: number): string {
  return new Date(now - GMAIL_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * How many alerts may have gone to Gmail by now in its day: a quarter of the limit from the start, the
 * rest released evenly, so a busy morning cannot leave the last hours of Gmail's day with nothing.
 * Rounded up, so the smallest limit still lets one through; never above the limit.
 */
export function gmailAllowance(limit: number, now: number): number {
  const elapsed = (((now - GMAIL_DAY_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.min(limit, Math.ceil(limit * (GMAIL_HEAD_START + (1 - GMAIL_HEAD_START) * (elapsed / DAY_MS))));
}
