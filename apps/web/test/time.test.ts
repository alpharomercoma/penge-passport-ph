import { describe, expect, it } from 'vitest';
import { manilaClock } from '../src/time.ts';

describe('manilaClock', () => {
  it('gives the time in Philippine time, whatever the device timezone', () => {
    expect(manilaClock('2026-10-13T06:36:00Z', Date.parse('2026-10-13T06:43:00Z'))).toBe('2:36 PM PHT');
    expect(manilaClock('2026-10-13T04:00:00Z', Date.parse('2026-10-13T04:01:00Z'))).toBe('12:00 PM PHT');
    expect(manilaClock('2026-10-12T16:05:00Z', Date.parse('2026-10-12T16:06:00Z'))).toBe('12:05 AM PHT');
  });

  it('adds the day when it was not today in Manila', () => {
    // 11:30 PM on 12 Oct in Manila, seen at 12:30 AM on 13 Oct there (the same UTC day).
    expect(manilaClock('2026-10-12T15:30:00Z', Date.parse('2026-10-12T16:30:00Z'))).toBe('11:30 PM PHT, 12 Oct');
  });

  it('says nothing for a time it cannot read', () => {
    expect(manilaClock('not a time', Date.parse('2026-10-13T06:43:00Z'))).toBe('');
  });
});
