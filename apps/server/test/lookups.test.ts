import { isOfficeDates, isOfficeTimes } from '@penge/contracts';
import fc from 'fast-check';
import { type Availability, RateLimitError, type TimeSlot } from 'penge-passport-ph';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { createLookups, type LookupUpstream, SCAN_RECENT_SECONDS, WARM_RETRY_MS, WARM_WITHIN_MS } from '../src/lookups.ts';
import { clock, FakeMailer, keys, MemoryKv } from './helpers.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 300);

const STATUS = {
  checkedAt: '2026-09-27T01:55:00.000Z',
  lastHealthyAt: '2026-09-27T01:55:00.000Z',
  healthy: true,
  sites: [
    { id: 486, name: 'Antipolo (SM Center)', address: 'SM Center Antipolo', ok: true, openDates: ['2026-10-05', '2026-10-07'], publishedDays: 20 },
    { id: 693, name: 'Baguio (SM City Baguio)', ok: true, openDates: [], publishedDays: 20 },
  ],
};

class FakeUpstream implements LookupUpstream {
  calls: string[] = [];
  /** Session warm-ups asked for, and whether the next ones fail. */
  warms = 0;
  warmFails = false;
  warmGate: Promise<void> | null = null;
  async warmSession({ withinMs }: { withinMs: number }): Promise<boolean> {
    this.warms++;
    expect(withinMs).toBe(WARM_WITHIN_MS);
    if (this.warmGate) await this.warmGate;
    if (this.warmFails) throw new Error('site down');
    return true;
  }
  fail = false;
  /** The rate limiter refuses, as when the hourly budget is spent. */
  limited = false;
  gate: Promise<void> | null = null;
  async availability({ siteId, applicants }: { siteId: number; applicants: number }): Promise<Availability> {
    this.calls.push(`dates:${siteId}:${applicants}`);
    if (this.gate) await this.gate;
    if (this.limited) throw new RateLimitError('Hourly budget of 1000 requests used', 60_000);
    if (this.fail) throw new Error('site down');
    const open = applicants <= 3 ? ['2026-10-05', '2026-10-07'] : ['2026-10-07'];
    const days = ['2026-10-05', '2026-10-06', '2026-10-07'].map((date) => ({ date, available: open.includes(date) }));
    return { siteId, from: '2026-10-01', to: '2027-03-31', applicants, earliest: open[0]!, availableDates: open, days, fetchedAt: '', cached: false };
  }
  async timeSlots({ siteId, date, applicants }: { siteId: number; date: string; applicants: number }): Promise<TimeSlot[]> {
    this.calls.push(`times:${siteId}:${date}:${applicants}`);
    if (this.limited) throw new RateLimitError('Hourly budget of 1000 requests used', 60_000);
    if (this.fail) throw new Error('site down');
    return [
      { start: '08:00', end: '09:00', available: true, remaining: null, status: 'Available', note: null },
      { start: '11:00', end: '12:00', available: false, remaining: null, status: 'Fully Booked', note: null },
      { start: '15:00', end: '16:00', available: true, remaining: 10, status: 'Available Slots: 10', note: null },
    ];
  }
}

async function setup() {
  const t = clock(Date.parse('2026-09-27T02:00:00Z'));
  const kv = new MemoryKv(t.now);
  await kv.set(K.status, JSON.stringify(STATUS));
  const upstream = new FakeUpstream();
  const lookups = createLookups({ kv, upstream, log: silentLog, now: t.now });
  let ip = '203.0.113.5';
  const app = createApi({ kv, keys, mailer: new FakeMailer(), log: silentLog, publicBaseUrl: 'https://x.example', now: t.now, lookups, clientIp: () => ip });
  const get = async (path: string, userAgent?: string) => {
    const res = await app.request(path, { headers: userAgent ? { 'user-agent': userAgent } : {} });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { t, kv, upstream, app, lookups, get, setIp: (next: string) => (ip = next) };
}

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('a DFA session ready before the tap', () => {
  it('is warmed when a person loads the page or opens an office, never for scripts', async () => {
    const s = await setup();
    const idle = () => new Promise((resolve) => setTimeout(resolve, 0)); // the warm-ups nobody waits for finish
    await s.get('/api/status', PHONE);
    await idle();
    expect(s.upstream.warms).toBe(1);
    await s.get('/api/offices/486/dates', PHONE);
    await idle();
    expect(s.upstream.warms).toBe(2);
    await s.get('/api/status', 'curl/8.7.1');
    await s.get('/api/offices/486/dates');
    await idle();
    expect(s.upstream.warms).toBe(2);
    expect(s.upstream.calls).toEqual([]); // warming asks nothing else of the DFA
  });

  it('runs one warm-up at a time, and rests after one fails', async () => {
    const s = await setup();
    let open!: () => void;
    s.upstream.warmGate = new Promise<void>((resolve) => (open = resolve));
    const a = s.lookups.warm();
    const b = s.lookups.warm();
    expect(s.upstream.warms).toBe(1);
    open();
    await Promise.all([a, b]);

    s.upstream.warmGate = null;
    s.upstream.warmFails = true;
    await expect(s.lookups.warm()).resolves.toBeUndefined(); // a failure is logged, never thrown
    await s.lookups.warm();
    expect(s.upstream.warms).toBe(2);
    s.t.advance(WARM_RETRY_MS);
    s.upstream.warmFails = false;
    await s.lookups.warm();
    expect(s.upstream.warms).toBe(3);
  });
});

describe('office dates', () => {
  it('answers one person from a recent scan, without asking the DFA again', async () => {
    const s = await setup(); // the scan is 5 minutes old
    const res = await s.get('/api/offices/486/dates');
    expect(res.status).toBe(200);
    expect(s.upstream.calls).toEqual([]); // the hours asked for next need not wait behind it
    expect(res.body).toEqual({ siteId: 486, applicants: 1, openDates: ['2026-10-05', '2026-10-07'], fullDates: [], windowEnd: null, checkedAt: STATUS.lastHealthyAt });

    // A stored answer newer than the scan is better still, and still costs no request.
    s.t.advance(4 * 60_000);
    await s.get('/api/offices/486/dates?applicants=2'); // a group lookup, stored
    const stored = await s.kv.get(K.lookup('dates:486:2'));
    await s.kv.set(K.lookup('dates:486:1'), stored!.replace('"applicants":2', '"applicants":1'));
    const calls = s.upstream.calls.length;
    const newer = await s.get('/api/offices/486/dates');
    expect(newer.body.checkedAt).toBe(new Date(s.t.now()).toISOString());
    expect(s.upstream.calls.length).toBe(calls);
  });

  it(`asks the DFA when the scans have fallen behind (over ${SCAN_RECENT_SECONDS / 60} minutes), and falls back to the scan if it cannot`, async () => {
    const s = await setup();
    s.t.advance(SCAN_RECENT_SECONDS * 1000); // the scan is now 13 minutes old
    const fresh = await s.get('/api/offices/486/dates');
    expect(s.upstream.calls).toEqual(['dates:486:1']);
    expect(fresh.body.checkedAt).toBe(new Date(s.t.now()).toISOString());
    expect(fresh.body.fullDates).toEqual(['2026-10-06']);

    const down = await setup();
    down.t.advance(SCAN_RECENT_SECONDS * 1000);
    down.upstream.fail = true;
    const scan = await down.get('/api/offices/486/dates');
    expect(scan.status).toBe(200);
    expect(scan.body).toEqual({ siteId: 486, applicants: 1, openDates: ['2026-10-05', '2026-10-07'], fullDates: [], windowEnd: null, checkedAt: STATUS.lastHealthyAt, warning: 'passport.gov.ph did not answer. Try again in a few minutes.' });

    // An office whose latest check failed shows dates from an earlier one, and says when.
    const stale = await setup();
    stale.upstream.fail = true;
    const older = '2026-09-27T01:25:00.000Z';
    const sites = STATUS.sites.map((x) => (x.id === 486 ? { ...x, ok: false, checkedAt: older } : x));
    await stale.kv.set(K.status, JSON.stringify({ ...STATUS, sites }));
    expect((await stale.get('/api/offices/486/dates')).body.checkedAt).toBe(older);
  });

  it('asks the DFA once for a group, then shares the answer for 3 minutes', async () => {
    const s = await setup();
    const first = await s.get('/api/offices/486/dates?applicants=4');
    expect(first.status).toBe(200);
    expect(isOfficeDates(first.body)).toBe(true);
    expect(first.body.openDates).toEqual(['2026-10-07']);
    expect(first.body.fullDates).toEqual(['2026-10-05', '2026-10-06']);
    expect(first.body.windowEnd).toBe('2027-03-31');
    s.t.advance(2 * 60_000);
    await s.get('/api/offices/486/dates?applicants=4');
    expect(s.upstream.calls).toEqual(['dates:486:4']);
    s.t.advance(60_000);
    await s.get('/api/offices/486/dates?applicants=4');
    expect(s.upstream.calls).toHaveLength(2);
  });

  it('turns many simultaneous identical questions into one request', async () => {
    const s = await setup();
    let release!: () => void;
    s.upstream.gate = new Promise((r) => (release = r));
    const pending = Promise.all(Array.from({ length: 8 }, () => s.get('/api/offices/486/dates?applicants=5')));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const answers = await pending;
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(s.upstream.calls).toEqual(['dates:486:5']);
  });
});

describe('office times', () => {
  it('keeps hours for 3 minutes only: they change fastest', async () => {
    const s = await setup();
    await s.get('/api/offices/486/times?date=2026-10-07');
    s.t.advance(2 * 60_000);
    await s.get('/api/offices/486/times?date=2026-10-07');
    expect(s.upstream.calls).toHaveLength(1);
    s.t.advance(60_000);
    await s.get('/api/offices/486/times?date=2026-10-07');
    expect(s.upstream.calls).toHaveLength(2);
  });

  it('lists the hours of a day with what the DFA says is left', async () => {
    const s = await setup();
    const res = await s.get('/api/offices/486/times?date=2026-10-07&applicants=2');
    expect(res.status).toBe(200);
    expect(isOfficeTimes(res.body)).toBe(true);
    expect(res.body.slots).toEqual([
      { start: '08:00', end: '09:00', available: true, remaining: null },
      { start: '11:00', end: '12:00', available: false, remaining: null },
      { start: '15:00', end: '16:00', available: true, remaining: 10 },
    ]);
  });

  it.each([
    ['/api/offices/999/times?date=2026-10-07', 404],
    ['/api/offices/abc/times?date=2026-10-07', 404],
    ['/api/offices/486/times?date=2026-9-7', 400],
    ['/api/offices/486/times?date=2026-09-26', 400], // yesterday in Manila
    ['/api/offices/486/times?date=2027-12-31', 400], // too far ahead
    ['/api/offices/486/times?date=2026-10-07&applicants=0', 400],
    ['/api/offices/486/times?date=2026-09-31', 400], // not a day of the calendar
    ['/api/offices/486/times?date=2026-10-07&applicants=6', 400], // the DFA's group form stops at 5
    ['/api/offices/486/dates?applicants=6', 400],
    ['/api/offices/486/times?date=2026-10-07&applicants=1.5', 400],
    ['/api/offices/486/dates?applicants=-1', 400],
  ])('refuses %s', async (path, status) => {
    const s = await setup();
    expect((await s.get(path)).status).toBe(status);
    expect(s.upstream.calls).toEqual([]);
  });
});

describe('staying polite to passport.gov.ph', () => {
  it('serves the older answer, or says so plainly, when the rate limiter refuses', async () => {
    const s = await setup();
    await s.get('/api/offices/486/times?date=2026-10-07'); // stored
    s.t.advance(4 * 60_000); // no longer fresh
    s.upstream.limited = true; // the lookups' hourly budget is spent
    const stale = await s.get('/api/offices/486/times?date=2026-10-07');
    expect(stale.status).toBe(200); // the older answer, rather than nothing
    expect(stale.body.warning).toMatch(/last saved answer/);
    expect(stale.body.checkedAt).toBe(new Date(s.t.now() - 4 * 60_000).toISOString());
    const none = await s.get('/api/offices/693/times?date=2026-10-20&applicants=4');
    expect(none.status).toBe(503);
    expect(none.body.error).toMatch(/^We ask passport.gov.ph only so often/);
  });

  it('says so plainly when the DFA does not answer', async () => {
    const s = await setup();
    s.upstream.fail = true;
    const res = await s.get('/api/offices/486/times?date=2026-10-07');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('passport.gov.ph did not answer. Try again in a few minutes.');
  });

  it('limits one network address', async () => {
    const s = await setup();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await s.get('/api/offices/486/dates')).status;
    expect(last).toBe(429);
  });

  it('fuzz: any office, date and group size gets a clear answer, never a 500', async () => {
    const s = await setup();
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constantFrom('486', '693', '0', '99999999', 'x', '-1', '486.0', '%00'), fc.string({ maxLength: 12 })),
        fc.oneof(fc.constantFrom('2026-10-07', '2026-02-30', '', '9999-99-99'), fc.string({ maxLength: 14 })),
        fc.oneof(fc.constantFrom('1', '4', '10', '11', '', 'NaN', '1e1'), fc.string({ maxLength: 4 })),
        fc.constantFrom('dates', 'times'),
        async (id, date, people, what) => {
          s.setIp(`10.9.${(++n >> 8) & 255}.${n & 255}`);
          const q = new URLSearchParams({ date, applicants: people });
          const res = await s.app.request(`/api/offices/${encodeURIComponent(id)}/${what}?${q}`);
          expect([200, 400, 404, 429, 503]).toContain(res.status);
          const body = await res.json();
          if (res.status === 200) expect(what === 'dates' ? isOfficeDates(body) : isOfficeTimes(body)).toBe(true);
        },
      ),
      { seed: 20260927, numRuns: RUNS },
    );
  }, 10_000 + RUNS * 10);
});
