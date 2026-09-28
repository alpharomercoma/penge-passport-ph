import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import { type CheckDeps, runCheck } from '../src/checker.ts';
import { K, manilaDay } from '../src/keys.ts';
import type { Logger } from '../src/log.ts';
import { createStats, dailyStats, isPerson, reportOncePerDay, SALT_SECONDS, statsKey } from '../src/stats.ts';
import { confirm, createPending } from '../src/subscribers.ts';
import { clock, FakeMailer, FakeUpstream, keys, MemoryKv, MemorySink, SITES } from './helpers.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const LAPTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function recordingLog() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m, f) => lines.push(JSON.stringify({ m, f })),
    warn: (m, f) => lines.push(JSON.stringify({ m, f })),
    error: (m, f) => lines.push(JSON.stringify({ m, f })),
  };
  return { log, lines };
}

/** Manila 10:00 on 27 September 2026; `advance` moves the clock. */
function counting() {
  const t = clock();
  const kv = new MemoryKv(t.now);
  const { log, lines } = recordingLog();
  const stats = createStats(kv, log, t.now);
  return { t, kv, log, lines, stats };
}

describe('counting visitors', () => {
  it('counts a person once a day however often they come, and each browser on a shared network apart', async () => {
    const { kv, stats } = counting();
    for (let i = 0; i < 5; i++) stats.visit('203.0.113.7', PHONE);
    stats.visit('203.0.113.7', LAPTOP);
    stats.visit('198.51.100.2', PHONE);
    await stats.settled();
    expect(await kv.pfCount(K.stat('2026-09-27', 'visitors'))).toBe(3);
  });

  it('does not count crawlers, link previews, monitors or scripts', async () => {
    const { kv, stats } = counting();
    for (const ua of [undefined, '', 'Googlebot/2.1', 'facebookexternalhit/1.1', 'curl/8.7.1', 'python-requests/2.32', 'Mozilla/5.0 HeadlessChrome/140.0', 'UptimeRobot/2.0 monitor', 'x'.repeat(600)]) {
      stats.visit('203.0.113.7', ua);
      stats.officeView(693, ua);
    }
    await stats.settled();
    expect(await kv.pfCount(K.stat('2026-09-27', 'visitors'))).toBe(0);
    expect(await kv.get(K.stat('2026-09-27', 'officeViews'))).toBeNull();
    expect(isPerson(PHONE)).toBe(true);
  });

  it('hashes with a new random salt each Manila day, and the salt is gone within a day', async () => {
    const { t, kv, stats } = counting();
    stats.visit('203.0.113.7', PHONE);
    await stats.settled();
    const first = await kv.get(K.statSalt('2026-09-27'));
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);

    t.advance(15 * 3600_000); // 01:00 on the 28th in Manila
    stats.visit('203.0.113.7', PHONE);
    await stats.settled();
    const second = await kv.get(K.statSalt('2026-09-28'));
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(await kv.pfCount(K.stat('2026-09-28', 'visitors'))).toBe(1);

    t.advance(SALT_SECONDS * 1000);
    expect(await kv.get(K.statSalt('2026-09-27'))).toBeNull();
    // The day's count outlives its salt.
    expect(await kv.pfCount(K.stat('2026-09-27', 'visitors'))).toBe(1);
  });

  it('never stores an address or a browser string', async () => {
    await fc.assert(
      fc.asyncProperty(fc.ipV4(), fc.ipV6(), fc.stringMatching(/^Mozilla\/5\.0 \([A-Za-z0-9 ;.]{4,40}\)$/), async (v4, v6, ua) => {
        const { kv, stats } = counting();
        stats.visit(v4, ua, { abroad: true });
        stats.visit(v6, ua);
        await stats.settled();
        const dump = kv.dump();
        expect(dump).not.toContain(v4);
        expect(dump).not.toContain(v6);
        expect(dump).not.toContain(ua);
      }),
      { numRuns: RUNS },
    );
  });

  it('never breaks what it counts when Redis fails', async () => {
    const { kv, stats, lines } = counting();
    kv.incr = async () => {
      throw new Error('redis down');
    };
    expect(() => stats.count('confirmEmails')).not.toThrow();
    await stats.settled();
    expect(lines.join('\n')).toContain('a daily number was not counted');
  });

  it('counts office views per office, and remembers when counting began', async () => {
    const { t, kv, stats } = counting();
    stats.officeView(693, PHONE);
    stats.officeView(693, LAPTOP);
    stats.officeView(486, PHONE);
    await stats.settled();
    t.advance(60_000);
    stats.count('hourLookups', 2);
    await stats.settled();
    expect(await kv.get(K.stat('2026-09-27', 'officeViews'))).toBe('3');
    expect(await kv.hGetAll(K.statOffices('2026-09-27'))).toEqual({ '693': '2', '486': '1' });
    expect(await kv.get(K.stat('2026-09-27', 'hourLookups'))).toBe('2');
    expect(await kv.get(K.statsSince)).toBe('2026-09-27T02:00:00.000Z');
  });
});

describe('the day in numbers', () => {
  it('adds the day up, names the offices opened most, and says when the day is only partly counted', async () => {
    const { kv, stats } = counting();
    await kv.set(K.sites, JSON.stringify(SITES.map(({ id, name }) => ({ id, name }))));
    stats.visit('203.0.113.7', PHONE, { abroad: true });
    stats.visit('198.51.100.2', PHONE);
    for (const id of [693, 693, 693, 486, 20, 99999]) stats.officeView(id, PHONE);
    stats.count('confirmed');
    stats.count('alertsSent', 4);
    await stats.settled();
    await kv.write([{ op: 'sAdd', key: K.allSubscribers, members: ['a', 'b'] }]);

    const day = await dailyStats(kv, '2026-09-27', Date.parse('2026-09-27T23:30:00Z'));
    expect(day).toMatchObject({
      schema: 1,
      day: '2026-09-27',
      partialFrom: '2026-09-27T02:00:00.000Z',
      visitors: 2,
      abroadVisitors: 1,
      subscribers: 2,
      generatedAt: '2026-09-27T23:30:00.000Z',
    });
    expect(day.counts).toMatchObject({ officeViews: 6, confirmed: 1, alertsSent: 4, unsubscribed: 0 });
    expect(day.topOffices).toEqual([
      { id: 693, name: 'Baguio (SM City Baguio)', views: 3 },
      { id: 20, name: 'Cebu (ROBINSONS GALLERIA , CEBU CITY )', views: 1 },
      { id: 486, name: 'Antipolo (SM Center, Antipolo City, Rizal)', views: 1 },
      { id: 99999, name: 'Office 99999', views: 1 },
    ]);
    // A later day was counted in full.
    expect((await dailyStats(kv, '2026-09-28', Date.now())).partialFrom).toBeNull();
  });
});

describe('the morning report', () => {
  async function reporting(opts: { statsEmail?: string | null } = {}) {
    const c = counting();
    const sink = new MemorySink();
    const objects = new Map<string, { body: string; type: string }>();
    let r2Fails = 0;
    sink.putObject = async (key, body, type) => {
      if (r2Fails > 0) {
        r2Fails--;
        throw new Error('R2 PUT 500');
      }
      objects.set(key, { body: new TextDecoder().decode(body), type });
    };
    const mailer = new FakeMailer();
    const deps = { kv: c.kv, sink, mailer, log: c.log, statsEmail: opts.statsEmail === undefined ? 'owner@example.com' : opts.statsEmail };
    c.stats.visit('203.0.113.7', PHONE);
    c.stats.count('confirmed');
    await c.stats.settled();
    const report = () => reportOncePerDay(deps, c.t.now());
    return { ...c, sink, mailer, objects, report, failR2: (n: number) => (r2Fails = n) };
  }

  it('waits for the morning, then stores and emails yesterday once', async () => {
    const r = await reporting();
    r.t.advance(20 * 3600_000); // 06:00 on the 28th in Manila
    await r.report();
    expect(r.objects.size).toBe(0);
    expect(r.mailer.sent).toHaveLength(0);

    r.t.advance(3600_000); // 07:00
    await r.report();
    await r.report();
    expect([...r.objects.keys()]).toEqual([statsKey('2026-09-27')]);
    expect(statsKey('2026-09-27')).toBe('stats/v1/date=2026-09-27/stats.json');
    const stored = JSON.parse(r.objects.get(statsKey('2026-09-27'))!.body);
    expect(r.objects.get(statsKey('2026-09-27'))!.type).toBe('application/json');
    expect(stored).toMatchObject({ day: '2026-09-27', visitors: 1, counts: { confirmed: 1 } });

    expect(r.mailer.sent).toHaveLength(1);
    const mail = r.mailer.sent[0]!;
    expect(mail).toMatchObject({ to: 'owner@example.com', kind: 'report' });
    expect(mail.unsubscribeUrl).toBeUndefined();
    expect(mail.subject).toBe('PengePassportPH, Sun 27 Sep 2026: 1 visitor, 1 new subscriber');
    expect(mail.text).toContain('Counting started at 10:00');
    expect(mail.text).toContain('New subscribers: 1');
    expect(mail.text).toContain('stats/v1/date=2026-09-27/stats.json');
    expect(mail.html).toContain('New subscribers');
  });

  it('retries R2 on the next run, and still emails on the first', async () => {
    const r = await reporting();
    r.t.advance(21 * 3600_000);
    r.failR2(1);
    await r.report();
    expect(r.objects.size).toBe(0);
    expect(r.mailer.sent).toHaveLength(1);
    await r.report();
    expect(r.objects.size).toBe(1);
    expect(r.mailer.sent).toHaveLength(1);
  });

  it('emails again after the mail server refused, but never after an uncertain failure', async () => {
    const r = await reporting();
    r.t.advance(21 * 3600_000);
    r.mailer.failNext = 1;
    await r.report();
    expect(r.mailer.sent).toHaveLength(0);
    await r.report();
    expect(r.mailer.sent).toHaveLength(1);

    r.t.advance(24 * 3600_000); // the next morning: the 28th, which had nothing counted but began after counting did
    r.mailer.uncertainNext = 1;
    await r.report();
    await r.report();
    expect(r.mailer.sent).toHaveLength(1);
  });

  it('only stores the numbers when nobody is to get them by email', async () => {
    const r = await reporting({ statsEmail: null });
    r.t.advance(21 * 3600_000);
    await r.report();
    expect(r.objects.size).toBe(1);
    expect(r.mailer.sent).toHaveLength(0);
  });

  it('reports nothing for days before counting began', async () => {
    const t = clock(Date.parse('2026-09-28T00:00:00Z')); // 08:00 on the 28th in Manila
    const kv = new MemoryKv(t.now);
    const sink = new MemorySink();
    const stored: string[] = [];
    sink.putObject = async (key) => void stored.push(key);
    const mailer = new FakeMailer();
    const { log } = recordingLog();
    await reportOncePerDay({ kv, sink, mailer, log, statsEmail: 'owner@example.com' }, t.now());
    const stats = createStats(kv, log, t.now);
    stats.count('runs');
    await stats.settled();
    await reportOncePerDay({ kv, sink, mailer, log, statsEmail: 'owner@example.com' }, t.now());
    expect(stored).toEqual([]);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('what the website counts', () => {
  async function site() {
    const t = clock();
    const kv = new MemoryKv(t.now);
    const { log } = recordingLog();
    const stats = createStats(kv, log, t.now);
    const mailer = new FakeMailer();
    await kv.set(K.sites, JSON.stringify(SITES.map(({ id, name }) => ({ id, name }))));
    const site = { id: 693, name: 'Baguio (SM City Baguio)', ok: true, openDates: ['2026-10-07'], fullDates: [], windowEnd: '2027-03-31', checkedAt: '2026-09-27T01:55:00.000Z' };
    await kv.set(K.status, JSON.stringify({ checkedAt: site.checkedAt, lastHealthyAt: site.checkedAt, healthy: true, sites: [site] }));
    let ip = '203.0.113.7';
    const app = createApi({ kv, keys, mailer, log, publicBaseUrl: 'https://penge.example', now: t.now, clientIp: () => ip, stats });
    const get = (path: string, ua = PHONE) => app.request(path, { headers: ua ? { 'user-agent': ua } : {} });
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': PHONE }, body: JSON.stringify(body) });
    const n = async (name: string) => Number((await kv.get(K.stat('2026-09-27', name))) ?? 0);
    return { kv, stats, mailer, get, post, n, setIp: (next: string) => (ip = next) };
  }

  it('counts visitors, offices opened, group checks and hours, not scripts', async () => {
    const s = await site();
    expect((await s.get('/api/status')).status).toBe(200);
    await s.get('/api/status');
    await s.get('/api/abroad');
    expect((await s.get('/api/offices/693/dates')).status).toBe(200);
    await s.get('/api/offices/693/dates?applicants=3');
    await s.get('/api/offices/693/times?date=2026-10-07');
    s.setIp('198.51.100.2');
    await s.get('/api/status');
    s.setIp('192.0.2.50');
    await s.get('/api/status', 'curl/8.7.1');
    await s.get('/api/offices/693/dates', 'curl/8.7.1');
    await s.get('/api/offices/1/dates'); // no such office: not a view
    await s.stats.settled();
    expect(await s.kv.pfCount(K.stat('2026-09-27', 'visitors'))).toBe(2);
    expect(await s.kv.pfCount(K.stat('2026-09-27', 'abroadVisitors'))).toBe(1);
    expect(await s.n('officeViews')).toBe(1);
    expect(await s.kv.hGetAll(K.statOffices('2026-09-27'))).toEqual({ '693': '1' });
    expect(await s.n('groupChecks')).toBe(1);
    expect(await s.n('hourLookups')).toBe(1);
  });

  it('counts confirmation emails, new subscribers, changes and unsubscribes', async () => {
    const s = await site();
    const token = async () => /\/confirm#token=([A-Za-z0-9_-]{43})/.exec(s.mailer.sent.at(-1)!.text)![1];
    expect((await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693], applicants: 1 })).status).toBe(202);
    await s.post('/api/confirm', { token: await token() });
    await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693, 486], applicants: 1 });
    await s.post('/api/confirm', { token: await token() });
    await s.post('/api/confirm', { token: await token() }); // used already: not counted
    const id = (await s.kv.sMembers(K.allSubscribers))[0]!;
    const { signUnsubscribe } = await import('../src/crypto.ts');
    await s.post('/api/unsubscribe', { token: signUnsubscribe(id, keys.token) });
    await s.post('/api/unsubscribe', { token: signUnsubscribe(id, keys.token) }); // gone already
    await s.stats.settled();
    expect(await s.n('confirmEmails')).toBe(2);
    expect(await s.n('confirmed')).toBe(1);
    expect(await s.n('updated')).toBe(1);
    expect(await s.n('unsubscribed')).toBe(1);
  });
});

describe('what the checker counts', () => {
  it('counts runs, dates found, alerts sent and alerts the daily cap held back', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    const { log } = recordingLog();
    const stats = createStats(kv, log, t.now);
    const upstream = new FakeUpstream();
    const mailer = new FakeMailer();
    const deps: CheckDeps = {
      kv,
      upstream,
      sink: new MemorySink(),
      mailer,
      keys,
      log,
      publicBaseUrl: 'https://penge.example',
      mailDailyLimit: 300,
      alertsPerSubscriberPerDay: 1,
      client: 'penge-passport-ph@test',
      now: t.now,
      stats,
    };
    const token = await createPending(kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1 }, t.now());
    await confirm(kv, token, t.now());
    let n = 0;
    const run = async () => {
      await runCheck({ ...deps, runId: `run${++n}` });
      t.advance(10 * 60_000);
    };
    await run();
    upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await run();
    upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    await run();
    upstream.failing = new Set([10, 20]);
    await run();
    const day = manilaDay(t.now());
    const numbers = await dailyStats(kv, day, t.now());
    expect(numbers.counts).toMatchObject({ runs: 4, healthyRuns: 3, datesOpened: 3, alertsSent: 1, alertsCapped: 1 });
    expect(mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(1);
  });
});
