import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/cache.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TtlCache', () => {
  it('does not cache failures', async () => {
    const cache = new TtlCache<number>();
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(7);
    await expect(cache.get('k', 1000, load)).rejects.toThrow('boom');
    await expect(cache.get('k', 1000, load)).resolves.toEqual({ value: 7, hit: false });
    await expect(cache.get('k', 1000, load)).resolves.toEqual({ value: 7, hit: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('starts the TTL when the load finishes, not when it starts', async () => {
    const cache = new TtlCache<string>();
    const slow = () => new Promise<string>((r) => setTimeout(() => r('v'), 5000));
    const first = cache.get('k', 1000, slow);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    await vi.advanceTimersByTimeAsync(900);
    await expect(cache.get('k', 1000, slow)).resolves.toMatchObject({ hit: true });
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const cache = new TtlCache<string>(2);
    for (const k of ['a', 'b', 'c']) await cache.get(k, 60_000, async () => k);
    const reload = vi.fn(async () => 'a2');
    await cache.get('a', 60_000, reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('never evicts a load still in flight, so callers keep sharing it', async () => {
    const cache = new TtlCache<string>(1);
    let finish!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const first = cache.get('slow', 60_000, slow);
    await cache.get('other', 60_000, async () => 'x'); // over the limit, while 'slow' is still loading
    const second = cache.get('slow', 60_000, slow);
    finish('done');
    expect((await first).value).toBe('done');
    expect((await second).value).toBe('done');
    expect(slow).toHaveBeenCalledOnce();
  });
});
