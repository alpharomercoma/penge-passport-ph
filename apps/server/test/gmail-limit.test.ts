import { describe, expect, it } from 'vitest';
import { gmailAllowance, gmailDay, isGmail } from '../src/gmail-limit.ts';

describe('the Gmail limit', () => {
  it('knows a Gmail address', () => {
    expect(isGmail('ana@gmail.com')).toBe(true);
    expect(isGmail('Ana@GoogleMail.com')).toBe(true);
    expect(isGmail('ana@example.com')).toBe(false);
    expect(isGmail('ana@gmail.com.ph')).toBe(false);
    expect(isGmail('ana@notgmail.com')).toBe(false);
    expect(isGmail('"gmail.com"@example.com')).toBe(false);
  });

  it('starts its day at 02:10 UTC', () => {
    expect(gmailDay(Date.parse('2026-11-10T02:09:59Z'))).toBe('2026-11-09');
    expect(gmailDay(Date.parse('2026-11-10T02:10:00Z'))).toBe('2026-11-10');
    expect(gmailDay(Date.parse('2026-11-10T23:59:59Z'))).toBe('2026-11-10');
  });

  it('allows a quarter at the start of the day and the rest evenly until its end', () => {
    expect(gmailAllowance(2000, Date.parse('2026-11-10T02:10:00Z'))).toBe(500);
    expect(gmailAllowance(2000, Date.parse('2026-11-10T14:10:00Z'))).toBe(1250);
    expect(gmailAllowance(2000, Date.parse('2026-11-11T02:09:59Z'))).toBe(2000);
    expect(gmailAllowance(0, Date.parse('2026-11-10T14:10:00Z'))).toBe(0);
    // The smallest limit still lets its one alert through, and no limit is ever passed.
    expect(gmailAllowance(1, Date.parse('2026-11-10T02:10:00Z'))).toBe(1);
    expect(gmailAllowance(3, Date.parse('2026-11-11T02:09:59Z'))).toBe(3);
  });
});
