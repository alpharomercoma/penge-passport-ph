import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError, RateLimitError } from '../src/errors.js';
import {
  FileStore,
  HostGate,
  LIMITS,
  parseRetryAfter,
  resolveLimits,
} from '../src/rate-limit.js';

const opts = { minIntervalMs: 3000, maxRequestsPerHour: 300, maxWaitMs: 60_000 };
const noJitter = () => 0;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-26T00:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HostGate', () => {
  it('runs tasks one at a time, spaced by the interval', async () => {
    const gate = new HostGate(noJitter);
    const started: number[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = async (report: (o: { ok: boolean }) => void) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      started.push(Date.now());
      await new Promise((r) => setTimeout(r, 500));
      running--;
      report({ ok: true });
    };
    const all = Promise.all([gate.run(opts, task), gate.run(opts, task), gate.run(opts, task)]);
    await vi.advanceTimersByTimeAsync(20_000);
    await all;
    expect(maxRunning).toBe(1);
    const t0 = started[0]!;
    expect(started.map((t) => t - t0)).toEqual([0, 3000, 6000]);
  });

  it('adds up to 25% jitter', async () => {
    const gate = new HostGate(() => 1);
    const started: number[] = [];
    const task = async (report: (o: { ok: boolean }) => void) => {
      started.push(Date.now());
      report({ ok: true });
    };
    const all = Promise.all([gate.run(opts, task), gate.run(opts, task)]);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(started[1]! - started[0]!).toBe(3750);
  });

  it('refuses once the hourly budget is spent, and says when to retry', async () => {
    const gate = new HostGate(noJitter);
    const small = { ...opts, maxRequestsPerHour: 2 };
    const ok = async (report: (o: { ok: boolean }) => void) => report({ ok: true });
    const first = Promise.all([gate.run(small, ok), gate.run(small, ok)]);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    const third = gate.run(small, ok);
    await expect(third).rejects.toBeInstanceOf(RateLimitError);
    // First request went out at t=0; it is now t=5s.
    await expect(third).rejects.toMatchObject({ retryAfterMs: 60 * 60 * 1000 - 5000 });
  });

  it('backs off exponentially after failures', async () => {
    const gate = new HostGate(noJitter);
    const started: number[] = [];
    const tracked = async (report: (o: { ok: boolean }) => void) => {
      started.push(Date.now());
      report({ ok: false });
    };
    const all = Promise.all([gate.run(opts, tracked), gate.run(opts, tracked), gate.run(opts, tracked)]);
    await vi.advanceTimersByTimeAsync(60_000);
    await all;
    const t0 = started[0]!;
    // 5 s after the first failure, 10 s after the second.
    expect(started.map((t) => t - t0)).toEqual([0, 5000, 15000]);
  });

  it('honours Retry-After when it is longer than the backoff', async () => {
    const gate = new HostGate(noJitter);
    const started: number[] = [];
    const all = Promise.all([
      gate.run(opts, async (report) => {
        started.push(Date.now());
        report({ ok: false, retryAfterMs: 45_000 });
      }),
      gate.run(opts, async (report) => {
        started.push(Date.now());
        report({ ok: true });
      }),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await all;
    expect(started[1]! - started[0]!).toBe(45_000);
  });

  it('refuses instead of queueing when the wait exceeds maxWaitMs', async () => {
    const gate = new HostGate(noJitter);
    await gate.run(opts, async (report) => report({ ok: false, retryAfterMs: 120_000 }));
    await expect(gate.run(opts, async () => undefined)).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfterMs: 120_000,
    });
  });

  it('opens the circuit after repeated failures and closes it after the cool-down', async () => {
    const gate = new HostGate(noJitter);
    const patient = { ...opts, maxWaitMs: Number.POSITIVE_INFINITY };
    const failing = Array.from({ length: LIMITS.circuitThreshold }, () =>
      gate.run(patient, async (report) => report({ ok: false })),
    );
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await Promise.all(failing);

    const blocked = gate.run(patient, async () => 'ran');
    await expect(blocked).rejects.toBeInstanceOf(CircuitOpenError);

    await vi.advanceTimersByTimeAsync(LIMITS.circuitOpenMs);
    const retried = gate.run(patient, async (report) => {
      report({ ok: true });
      return 'ran';
    });
    await vi.advanceTimersByTimeAsync(LIMITS.backoffMaxMs);
    await expect(retried).resolves.toBe('ran');
    expect((await gate.stats()).consecutiveFailures).toBe(0);
  });

  it('counts a thrown transport error as a failure', async () => {
    const gate = new HostGate(noJitter);
    await expect(
      gate.run(opts, async () => {
        throw new TypeError('fetch failed');
      }),
    ).rejects.toThrow('fetch failed');
    expect((await gate.stats()).consecutiveFailures).toBe(1);
  });

  it('does not count caller cancellation as a failure', async () => {
    const gate = new HostGate(noJitter);
    await expect(
      gate.run(opts, async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    ).rejects.toThrow('aborted');
    expect((await gate.stats()).consecutiveFailures).toBe(0);
  });

  it('keeps serving the queue after a task throws', async () => {
    const gate = new HostGate(noJitter);
    const bad = gate.run(opts, async (report) => {
      report({ ok: true });
      throw new Error('parse error');
    });
    const good = gate.run(opts, async (report) => {
      report({ ok: true });
      return 42;
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(bad).rejects.toThrow('parse error');
    await expect(good).resolves.toBe(42);
  });
});

describe('HostGate queue deadline', () => {
  it('counts time spent queued against maxWaitMs', async () => {
    const gate = new HostGate(noJitter);
    const tight = { ...opts, maxWaitMs: 5000 };
    const ok = async (report: (o: { ok: boolean }) => void) => report({ ok: true });
    const calls = [gate.run(tight, ok), gate.run(tight, ok), gate.run(tight, ok)];
    const settled = Promise.allSettled(calls);
    await vi.advanceTimersByTimeAsync(10_000);
    const [a, b, c] = await settled;
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('fulfilled'); // sent at 3 s
    expect(c).toMatchObject({ status: 'rejected', reason: { name: 'RateLimitError' } }); // would be 6 s
  });
});

describe('HostGate expired deadline', () => {
  it('refuses a call whose deadline passed while queued, even if the gate is ready', async () => {
    const gate = new HostGate(noJitter);
    const slow = gate.run(opts, async (report) => {
      await new Promise((r) => setTimeout(r, 70_000));
      report({ ok: true });
    });
    const queued = gate.run(opts, async () => 'sent');
    queued.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(80_000);
    await slow;
    await expect(queued).rejects.toMatchObject({ name: 'RateLimitError' });
  });
});

describe('HostGate shared through a state file (separate processes)', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'pps-gate-')), 'host.json');
  const ok = async (report: (o: { ok: boolean }) => void) => report({ ok: true });

  it('keeps one spacing across gates that only share the file', async () => {
    const path = file();
    const a = new HostGate(noJitter, new FileStore(path));
    const b = new HostGate(noJitter, new FileStore(path));
    const started: number[] = [];
    const tracked = async (report: (o: { ok: boolean }) => void) => {
      started.push(Date.now());
      report({ ok: true });
    };
    const all = Promise.all([a.run(opts, tracked), b.run(opts, tracked), a.run(opts, tracked), b.run(opts, tracked)]);
    await vi.advanceTimersByTimeAsync(30_000);
    await all;
    const t0 = started[0]!;
    expect(started.map((t) => t - t0)).toEqual([0, 3000, 6000, 9000]);
  });

  it('shares the hourly budget and the backoff', async () => {
    const path = file();
    const a = new HostGate(noJitter, new FileStore(path));
    const b = new HostGate(noJitter, new FileStore(path));
    const small = { ...opts, maxRequestsPerHour: 2 };
    const first = Promise.all([a.run(small, ok), a.run(small, ok)]);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    await expect(b.run(small, ok)).rejects.toMatchObject({ name: 'RateLimitError' });

    const other = file();
    const c = new HostGate(noJitter, new FileStore(other));
    const d = new HostGate(noJitter, new FileStore(other));
    await c.run(opts, async (report) => report({ ok: false, retryAfterMs: 90_000 }));
    expect(await d.stats()).toMatchObject({ consecutiveFailures: 1, pausedForMs: 90_000 });
  });

  it('clamps implausible values in a well-formed state file instead of trusting them', async () => {
    const path = file();
    const future = Date.now() + 10 * HOUR;
    writeFileSync(path, JSON.stringify({ lastDispatchAt: 9e15, pauseUntil: 9e15, consecutiveFailures: 2, circuitOpenUntil: 9e15, dispatched: [future] }));
    const stats = await new HostGate(noJitter, new FileStore(path)).stats();
    expect(stats.pausedForMs).toBeLessThanOrEqual(LIMITS.retryAfterMaxMs + LIMITS.circuitOpenMs);
    expect(stats.requestsLastHour).toBe(1); // a record from "the future" counts as now, never as gone
  });

  const valid = { lastDispatchAt: 0, pauseUntil: 0, consecutiveFailures: 0, circuitOpenUntil: 0, dispatched: [] as unknown[] };
  it.each([
    '{not json',
    'null',
    '[]',
    '7',
    JSON.stringify({ ...valid, dispatched: 'x' }),
    JSON.stringify({ ...valid, dispatched: [1, 'x'] }),
    JSON.stringify({ ...valid, pauseUntil: '0' }),
    JSON.stringify({ lastDispatchAt: 0, pauseUntil: 0, circuitOpenUntil: 0, dispatched: [] }),
  ])('waits out the hour when the state file is unreadable (%s)', async (text) => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const path = file();
    writeFileSync(path, text);
    // What was sent in the last hour is unknown, so nothing is sent until it has passed.
    const stats = await new HostGate(noJitter, new FileStore(path)).stats();
    expect(stats.pausedForMs).toBeGreaterThan(HOUR - 1_000);
    expect(stats.pausedForMs).toBeLessThanOrEqual(HOUR);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('falls back to this process, with a warning, when the file cannot be written', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const gate = new HostGate(noJitter, new FileStore('/dev/null/not-a-dir/host.json'));
    await gate.run(opts, ok);
    expect(warn).toHaveBeenCalledOnce();
    expect((await gate.stats()).requestsLastHour).toBe(1);
    warn.mockRestore();
  });

  it('reclaims a lock whose owner process has died', async () => {
    const path = file();
    writeFileSync(`${path}.lock`, '999999999:dead-token');
    const gate = new HostGate(noJitter, new FileStore(path));
    await gate.run(opts, ok);
    expect((await gate.stats()).requestsLastHour).toBe(1);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('refuses (fails closed) while a live process holds the lock', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const path = file();
    writeFileSync(`${path}.lock`, `${process.pid}:someone-else`);
    const gate = new HostGate(noJitter, new FileStore(path));
    const attempt = gate.run(opts, ok);
    attempt.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(attempt).rejects.toMatchObject({ name: 'RateLimitError' });
    expect(warn).not.toHaveBeenCalled(); // no silent downgrade to per-process limits
    warn.mockRestore();
  });

  it('does not overwrite a state file it cannot read', async () => {
    if (process.getuid?.() === 0) return; // root reads through chmod 000
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const path = file();
    const history = JSON.stringify({ lastDispatchAt: Date.now(), dispatched: [Date.now()] });
    writeFileSync(path, history);
    chmodSync(path, 0o000);
    await new HostGate(noJitter, new FileStore(path)).run(opts, ok);
    chmodSync(path, 0o600);
    expect(readFileSync(path, 'utf8')).toBe(history);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('keeps the budget spent after the wall clock goes back more than an hour', async () => {
    const path = file();
    const small = { ...opts, maxRequestsPerHour: 2 };
    const a = new HostGate(noJitter, new FileStore(path));
    const both = Promise.all([a.run(small, ok), a.run(small, ok)]);
    await vi.advanceTimersByTimeAsync(5000);
    await both;
    vi.setSystemTime(Date.now() - 2 * 3_600_000); // the wall clock jumps back two hours
    const fresh = new HostGate(noJitter, new FileStore(path)); // another process: no local memory
    await expect(fresh.run(small, ok)).rejects.toMatchObject({ name: 'RateLimitError' });
  });

  it('re-reads the clock after waiting for another process\'s lock', async () => {
    const path = file();
    writeFileSync(`${path}.lock`, `${process.pid}:someone-else`);
    const gate = new HostGate(noJitter, new FileStore(path));
    const call = gate.run({ ...opts, maxWaitMs: 100 }, ok);
    call.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500); // the lock is held past the 100 ms deadline
    rmSync(`${path}.lock`);
    await vi.advanceTimersByTimeAsync(100);
    await expect(call).rejects.toMatchObject({ name: 'RateLimitError' });
    expect((await gate.stats()).requestsLastHour).toBe(0); // nothing recorded as sent
  });

  it('writes state a second process can read', async () => {
    const path = file();
    await new HostGate(noJitter, new FileStore(path)).run(opts, ok);
    expect(JSON.parse(readFileSync(path, 'utf8')).dispatched).toHaveLength(1);
  });
});

describe('resolveLimits', () => {
  it('uses safe defaults', () => {
    expect(resolveLimits({})).toEqual({ minIntervalMs: 3000, maxRequestsPerHour: 300 });
  });

  it('allows slower, never faster', () => {
    expect(resolveLimits({ minIntervalMs: 10_000, maxRequestsPerHour: 60 })).toEqual({
      minIntervalMs: 10_000,
      maxRequestsPerHour: 60,
    });
    expect(() => resolveLimits({ minIntervalMs: 1999 })).toThrow(RangeError);
    expect(() => resolveLimits({ minIntervalMs: Number.NaN })).toThrow(RangeError);
    expect(() => resolveLimits({ maxRequestsPerHour: 1201 })).toThrow(RangeError);
    expect(resolveLimits({ maxRequestsPerHour: 1200 }).maxRequestsPerHour).toBe(1200);
    expect(() => resolveLimits({ maxRequestsPerHour: 0 })).toThrow(RangeError);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(new Date(Date.now() + 90_000).toUTCString())).toBe(90_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
