// How much this server asks of passport.gov.ph, as two budgets that never
// compete: the scans that every alert depends on, and what visitors ask for
// when they open an office or tap a day. Each has its own rate limiter (its
// own state directory), so a busy hour of visitors can never delay a scan.
// Both stay under the library's hard ceiling; docs/legal explains the numbers.
import { join } from 'node:path';

/** Scans start every 5 minutes (deploy/systemd/penge-check.timer). */
export const SCANS_PER_HOUR = 12;

/**
 * One scan is at most 43 offices, a session and the office list (45), up to
 * RETRY_CAP offices tried again (3) and GROUP_QUERY_CAP group checks (10):
 * 12 x 58 = 696 an hour at most. test/budget.test.ts checks the sum.
 */
export const SCAN_REQUESTS_PER_HOUR = 720;

/** Visitors' lookups, and this server's own session renewals, in any rolling hour. */
export const LOOKUP_REQUESTS_PER_HOUR = 1000;

export const scanStateDir = (base: string) => join(base, 'scans');
export const lookupStateDir = (base: string) => join(base, 'lookups');
