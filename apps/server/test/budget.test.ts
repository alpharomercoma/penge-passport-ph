import { readFileSync } from 'node:fs';
import { LIMITS } from 'penge-passport-ph';
import { describe, expect, it } from 'vitest';
import { LOOKUP_REQUESTS_PER_HOUR, SCAN_REQUESTS_PER_HOUR, SCANS_PER_HOUR, lookupStateDir, scanStateDir } from '../src/budget.ts';
import { GROUP_QUERY_CAP, RETRY_CAP } from '../src/checker.ts';

describe('what the server asks of passport.gov.ph', () => {
  it('fits every scan the timer starts into the scans\' own budget', () => {
    const timer = readFileSync(new URL('../../../deploy/systemd/penge-check.timer', import.meta.url), 'utf8');
    const every = Number(/^OnCalendar=\*:\d+\/(\d+)$/m.exec(timer)?.[1]);
    expect(60 / every).toBe(SCANS_PER_HOUR);
    // 43 offices, a session and the office list, the retries, and the group checks.
    const worstScan = 45 + RETRY_CAP + GROUP_QUERY_CAP;
    expect(SCANS_PER_HOUR * worstScan).toBeLessThanOrEqual(SCAN_REQUESTS_PER_HOUR);
  });

  it('keeps both budgets under the library\'s hard ceiling, on separate rate limiters', () => {
    expect(SCAN_REQUESTS_PER_HOUR).toBeLessThanOrEqual(LIMITS.maxRequestsPerHourCeiling);
    expect(LOOKUP_REQUESTS_PER_HOUR).toBeLessThanOrEqual(LIMITS.maxRequestsPerHourCeiling);
    expect(scanStateDir('/var/lib/penge/limiter')).not.toBe(lookupStateDir('/var/lib/penge/limiter'));
  });
});
