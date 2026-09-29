// The privacy page (apps/web/src/pages/Privacy.tsx) says how long things are kept. These are the
// numbers the server and the deploy scripts actually use: change one and this fails until the page
// says the same.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKUP_KEEP_DAYS } from '../src/checker.ts';
import { API_LIMITS } from '../src/limits.ts';
import { SALT_SECONDS, STATS_KEEP_SECONDS } from '../src/stats.ts';
import { PENDING_TTL_SECONDS } from '../src/subscribers.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('../../web/src/pages/Privacy.tsx').replace(/\s+/g, ' ');

describe('the privacy page', () => {
  it('keeps an unconfirmed sign-up as long as the server does', () => {
    expect(page).toContain(`A sign-up that is never confirmed is deleted after ${PENDING_TTL_SECONDS / 3600} hours.`);
    expect(page).toContain(`A sign-up you never confirm deletes itself after ${PENDING_TTL_SECONDS / 3600} hours.`);
  });

  it('keeps backups as long as the checker does', () => {
    expect(page).toContain(`Backups are kept for ${BACKUP_KEEP_DAYS} days`);
    expect(page).toContain(`are gone within ${BACKUP_KEEP_DAYS} days`);
  });

  it('deletes the daily visitor salt, and its copy in the database log, when the server does', () => {
    // The salt's own life, then at most an hour in Valkey's log until the hourly rewrite.
    expect(page).toContain(`The daily value is deleted within ${SALT_SECONDS / 3600 + 1} hours`);
  });

  it('clears deleted data from the database log as often as it says', () => {
    const timer = read('../../../deploy/systemd/penge-valkey-compact.timer');
    expect(timer).toMatch(/^OnCalendar=hourly$/m);
    // A run missed while the server was off happens at boot.
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(read('../../../deploy/provision.sh')).toMatch(/^systemctl enable .*penge-valkey-compact\.timer/m);
    expect(page).toContain('rewritten every hour');
  });

  it('keeps the daily totals as long as the server does', () => {
    expect(page).toContain(`They stay on our server for ${STATS_KEEP_SECONDS / 86_400} days`);
  });

  it('expires per-address counters when the limiter does', () => {
    // hit() keeps each window's counter for two windows and a minute.
    const perAddress = Object.entries(API_LIMITS).filter(([name]) => name.endsWith('PerIp'));
    expect(perAddress.length).toBeGreaterThan(0);
    for (const [, limit] of perAddress) expect(limit.windowSeconds * 2 + 60).toBe(2 * 3600 + 60);
    expect(page).toContain('those counts expire after about two hours');
  });

  it('forgets the confirmations counted per email address when the limiter does', () => {
    const { windowSeconds } = API_LIMITS.confirmationsPerEmail;
    expect(windowSeconds * 2 + 60).toBe(2 * 86_400 + 60);
    expect(page).toContain('forget the count after about two days');
  });

  it('keeps the error log and the mail logs as long as the server is set to', () => {
    expect(read('../../../deploy/provision.sh')).toMatch(/^MaxRetentionSec=14day$/m);
    expect(page).toContain('that log is kept for 14 days');
    // Rotated daily, 3 old files kept: today plus 3 days.
    expect(read('../../../deploy/mail/setup-mail.sh').match(/^\s*rotate 3$/gm)).toHaveLength(2);
    expect(page).toContain('keep your address for up to 4 days');
  });
});
