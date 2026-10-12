// How many notification alerts the server takes: from Valkey's maxmemory, by the measured footprint
// (devices-footprint.test.ts fills a real Valkey at these ceilings and checks they fit in a quarter of it).
import { describe, expect, it } from 'vitest';
import { memoryCeiling, resolveDeviceLimits } from '../src/devices/capacity.ts';
import { parseMemoryInfo } from '../src/kv.ts';
import { valkeyTargets } from './valkey.ts';

const MB = 1024 * 1024;

describe('the notification ceiling, from memory', () => {
  it('keeps at least the measured 270 alerts at 64 MB, with 6 units each and 80 to spare', () => {
    const c = memoryCeiling(64 * MB);
    expect(c.alertLimit).toBeGreaterThanOrEqual(270);
    expect(c.recordLimit).toBe(c.alertLimit * 6 + 80);
  });

  it('grows with maxmemory: the fixed part does not', () => {
    expect(memoryCeiling(128 * MB).alertLimit).toBeGreaterThanOrEqual(800);
    expect(memoryCeiling(256 * MB).alertLimit).toBeGreaterThanOrEqual(1800);
    expect(memoryCeiling(32 * MB).alertLimit).toBeLessThan(memoryCeiling(64 * MB).alertLimit);
  });

  it('is none, alerts and units, when a quarter of memory cannot even hold the fixed part', () => {
    expect(memoryCeiling(16 * MB)).toEqual({ alertLimit: 0, recordLimit: 0 });
  });

  it('reads an unlimited Valkey (maxmemory 0) as 64 MB, never as unlimited', () => {
    expect(memoryCeiling(0)).toEqual(memoryCeiling(64 * MB));
  });
});

describe('the limits a server runs with', () => {
  it('takes the ceiling when none is set', () => {
    expect(resolveDeviceLimits({ alertLimit: null, recordLimit: null }, 128 * MB)).toEqual({ limits: memoryCeiling(128 * MB), capped: false });
  });

  it('keeps lower limits that are set', () => {
    expect(resolveDeviceLimits({ alertLimit: 100, recordLimit: 600 }, 128 * MB)).toEqual({ limits: { alertLimit: 100, recordLimit: 600 }, capped: false });
    // Only the alerts set: the units follow them.
    expect(resolveDeviceLimits({ alertLimit: 100, recordLimit: null }, 128 * MB)).toEqual({ limits: { alertLimit: 100, recordLimit: 680 }, capped: false });
  });

  it('caps limits above what memory holds, and says so (never refuses: the site and email go on)', () => {
    expect(resolveDeviceLimits({ alertLimit: 5000, recordLimit: 30_080 }, 64 * MB)).toEqual({ limits: memoryCeiling(64 * MB), capped: true });
    expect(resolveDeviceLimits({ alertLimit: 100, recordLimit: 50_000 }, 64 * MB)).toEqual({ limits: { alertLimit: 100, recordLimit: memoryCeiling(64 * MB).recordLimit }, capped: true });
  });
});

describe("reading Valkey's memory", () => {
  it('reads used_memory and maxmemory from INFO memory', () => {
    expect(parseMemoryInfo('# Memory\r\nused_memory:2783744\r\nused_memory_human:2.65M\r\nmaxmemory:67108864\r\n')).toEqual({ used: 2783744, max: 67108864 });
    expect(parseMemoryInfo('used_memory:10\nmaxmemory:0\n')).toEqual({ used: 10, max: 0 });
  });

  it('refuses a reading with either field missing or malformed, never reading it as 0', () => {
    expect(() => parseMemoryInfo('used_memory:10\n')).toThrow(/maxmemory/);
    expect(() => parseMemoryInfo('maxmemory:10\n')).toThrow(/used_memory/);
    expect(() => parseMemoryInfo('used_memory:10x\nmaxmemory:10\n')).toThrow(/used_memory/);
    expect(() => parseMemoryInfo('used_memory:10\nmaxmemory:\n')).toThrow(/maxmemory/);
  });
});

describe.each(valkeyTargets())("a live memory reading (%s)", (_target, make) => {
  it('gives a whole used_memory and maxmemory', async () => {
    const kv = await make();
    try {
      const m = await kv.memory();
      expect(Number.isInteger(m.used) && m.used >= 0).toBe(true);
      expect(Number.isInteger(m.max) && m.max >= 0).toBe(true);
    } finally {
      await kv.close();
    }
  });
});
