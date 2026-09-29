import { describe, expect, it } from 'vitest';
import { elapsed, parseStamp, stampAt } from '../src/clock.ts';

describe('clock', () => {
  it('measures by uptime within a boot, whatever the wall clock says', () => {
    const then = { wall: 1_000_000, up: 50_000, boot: 'a' };
    expect(elapsed(then, { wall: 1_000_000 + 7_200_000, up: 60_000, boot: 'a' })).toBe(10_000); // stepped 2 h ahead
    expect(elapsed(then, { wall: 1_000_000 - 86_400_000, up: 60_000, boot: 'a' })).toBe(10_000); // stepped a day back
  });

  it('calls a moment from another boot unknown, whatever the clock says', () => {
    const then = { wall: 1_000_000, up: 50_000, boot: 'a' };
    for (const wall of [1_600_000, 99_000_000, 900_000]) expect(elapsed(then, { wall, up: 9_000, boot: 'b' })).toBeNull();
  });

  it('calls a stamp from later in this same boot, or with uptime when this reading has none, unknown', () => {
    expect(elapsed({ wall: 1, up: 9_000, boot: 'a' }, { wall: 2, up: 5_000, boot: 'a' })).toBeNull();
    expect(elapsed({ wall: 1_000, up: 9_000, boot: 'a' }, { wall: 999_000 })).toBeNull();
  });

  it('says when it cannot tell, and uses the wall clock only where there is no uptime', () => {
    expect(elapsed({ wall: 1_000_000 }, { wall: 1_000_500, up: 9, boot: 'a' })).toBeNull(); // from before boots were recorded
    expect(elapsed({ wall: 1_000_000 }, { wall: 1_000_500 })).toBe(500);
    expect(elapsed({ wall: 1_000_000, up: 5, boot: 'a' }, { wall: 999_000 })).toBeNull();
  });

  it('reads stamps as stored, including the old bare numbers, and refuses anything else', () => {
    expect(parseStamp('1790475000000')).toEqual({ wall: 1790475000000 });
    expect(parseStamp(1790475000000)).toEqual({ wall: 1790475000000 });
    expect(parseStamp('{"wall":5,"up":6,"boot":"a"}')).toEqual({ wall: 5, up: 6, boot: 'a' });
    expect(parseStamp('{"wall":5,"up":6}')).toEqual({ wall: 5 }); // uptime without its boot is no use
    for (const bad of [null, undefined, '', 'x', '{"up":6,"boot":"a"}', '{"wall":"5"}', NaN, [], true]) expect(parseStamp(bad)).toBeNull();
  });

  it('stamps with uptime where the system gives it, and with the wall clock alone where it does not', () => {
    expect(stampAt(5, () => ({ up: 7, boot: 'a' }))).toEqual({ wall: 5, up: 7, boot: 'a' });
    expect(stampAt(5, () => null)).toEqual({ wall: 5 });
  });
});
