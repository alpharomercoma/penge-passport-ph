// How much this server asks of passport.gov.ph, as three budgets that never
// compete: the scans of the offices at home that most alerts depend on, the
// posts abroad (checked about hourly, 36 per run), and what visitors ask
// for when they open an office or tap a day. Each has its own rate limiter
// (its own state directory), so a busy hour of visitors can never delay a
// scan. All stay under the library's hard ceiling; docs/legal explains them.
import { join } from 'node:path';

/** Scans start every 15 minutes (deploy/systemd/penge-check.timer). */
export const SCANS_PER_HOUR = 4;

/**
 * One scan is at most 43 offices, a session and the office list (45), up to
 * RETRY_CAP offices tried again (3) and GROUP_QUERY_CAP group checks (10):
 * 4 x 58 = 232 an hour at most, with room for one run started by hand (a
 * sweep of the posts abroad). test/budget.test.ts checks the sum.
 */
export const SCAN_REQUESTS_PER_HOUR = 300;

/**
 * Posts abroad, per run: a session, ABROAD_REQUESTS_PER_RUN (42) shared by the
 * posts (36) and the weekly reading of their list (6; all 42 while it is read
 * for the first time), and ABROAD_GROUP_CAP group checks (4): 4 x 47 = 188 an
 * hour at most, leaving room for a sweep of every post by hand (about 135).
 * test/budget.test.ts checks it.
 */
export const ABROAD_REQUESTS_PER_HOUR = 300;

/** Visitors' lookups, and this server's own session renewals, in any rolling hour. */
export const LOOKUP_REQUESTS_PER_HOUR = 1000;

export const scanStateDir = (base: string) => join(base, 'scans');
export const lookupStateDir = (base: string) => join(base, 'lookups');
export const abroadStateDir = (base: string) => join(base, 'abroad');
