import { readFileSync } from 'node:fs';
import { LIMITS } from 'penge-passport-ph';
import { describe, expect, it } from 'vitest';
import { ABROAD_GROUP_CAP, ABROAD_POSTS_PER_RUN, ABROAD_REQUESTS_PER_RUN, CATALOG_STEPS_PER_RUN } from '../src/abroad.ts';
import {
  ABROAD_REQUESTS_PER_HOUR,
  abroadStateDir,
  LOOKUP_REQUESTS_PER_HOUR,
  lookupStateDir,
  SCAN_REQUESTS_PER_HOUR,
  SCANS_PER_HOUR,
  scanStateDir,
} from '../src/budget.ts';
import { GROUP_QUERY_CAP, RETRY_CAP } from '../src/checker.ts';

describe('what the server asks of passport.gov.ph', () => {
  it('fits every scan the timer starts into the scans\' own budget', () => {
    const timer = readFileSync(new URL('../../../deploy/systemd/penge-check.timer', import.meta.url), 'utf8');
    const every = Number(/^OnCalendar=\*:\d+\/(\d+)$/m.exec(timer)?.[1]);
    // A random delay would let two starts come closer than `every`, and one more fit in an hour.
    const jitter = Number(/^RandomizedDelaySec=(\d+)/m.exec(timer)?.[1] ?? 0);
    expect(60 / every + (jitter > 0 ? 1 : 0)).toBe(SCANS_PER_HOUR);
    // 43 offices, a session and the office list, the retries, and the group checks.
    const worstScan = 45 + RETRY_CAP + GROUP_QUERY_CAP;
    expect(SCANS_PER_HOUR * worstScan).toBeLessThanOrEqual(SCAN_REQUESTS_PER_HOUR);
  });

  it('fits every run\'s share of the posts abroad into their own budget', () => {
    // A session, the posts and the reading of their list (sharing one allowance), and the group checks.
    expect(ABROAD_REQUESTS_PER_RUN).toBe(ABROAD_POSTS_PER_RUN + CATALOG_STEPS_PER_RUN);
    const worstRun = 1 + ABROAD_REQUESTS_PER_RUN + ABROAD_GROUP_CAP;
    expect(SCANS_PER_HOUR * worstRun).toBeLessThanOrEqual(ABROAD_REQUESTS_PER_HOUR);
    // Enough runs an hour to check about 140 posts hourly (133 were listed in September 2026).
    expect(SCANS_PER_HOUR * ABROAD_POSTS_PER_RUN).toBeGreaterThanOrEqual(140);
  });

  it('keeps every budget under the library\'s hard ceiling, on separate rate limiters', () => {
    expect(SCAN_REQUESTS_PER_HOUR).toBeLessThanOrEqual(LIMITS.maxRequestsPerHourCeiling);
    expect(LOOKUP_REQUESTS_PER_HOUR).toBeLessThanOrEqual(LIMITS.maxRequestsPerHourCeiling);
    expect(ABROAD_REQUESTS_PER_HOUR).toBeLessThanOrEqual(LIMITS.maxRequestsPerHourCeiling);
    const dirs = [scanStateDir, lookupStateDir, abroadStateDir].map((f) => f('/var/lib/penge/limiter'));
    expect(new Set(dirs).size).toBe(3);
  });
});
