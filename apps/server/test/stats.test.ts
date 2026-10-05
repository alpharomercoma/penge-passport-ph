import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import { type CheckDeps, runCheck } from '../src/checker.ts';
import { K, manilaDay } from '../src/keys.ts';
import type { Logger } from '../src/log.ts';
import { COUNTS, type Count, createStats, dailyStats, isPerson, reportOncePerDay, SALT_SECONDS, statsKey } from '../src/stats.ts';
import { dailyStatsEmail } from '../src/templates.ts';
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

  it('keeps the salt only in Redis, so when Redis deletes it no copy is left', async () => {
    const { kv, stats } = counting();
    stats.visit('203.0.113.7', PHONE);
    await stats.settled();
    const first = await kv.get(K.statSalt('2026-09-27'));
    await kv.write([{ op: 'del', key: K.statSalt('2026-09-27') }]);
    // The same process on the same day: a salt it had kept would be used again, and not stored.
    stats.visit('198.51.100.2', PHONE);
    await stats.settled();
    const second = await kv.get(K.statSalt('2026-09-27'));
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
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

  it("reports the limit the day enforced, not the one set when the report is made", async () => {
    const r = await reporting();
    await r.kv.set(K.mailLimit('2026-09-27'), '300'); // what that day's runs enforced; the setting is 2,500 by now
    r.t.advance(21 * 3600_000);
    await r.report();
    expect(r.mailer.sent[0]!.text).toContain('Alerts sent: 0 of 300 allowed a day');
    expect(JSON.parse(r.objects.get(statsKey('2026-09-27'))!.body).mailLimit).toBe(300);
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
    const app = createApi({ kv, keys, mailer, log, publicBaseUrl: 'https://penge.example', now: t.now, clientIp: () => ip, stats, push: { mode: 'off', vapid: null, ownerEmails: [] } });
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
      // The fake clock, not this machine's uptime (Linux has one, macOS does not): the same on every machine.
      uptime: () => null,
      now: t.now,
      stats,
    };
    const token = await createPending(kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: null }, t.now());
    await confirm(kv, keys, token, t.now());
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

  it('counts a run the site-wide daily email limit stopped, apart from the per-person cap', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    const { log } = recordingLog();
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
      mailDailyLimit: 1,
      alertsPerSubscriberPerDay: 288,
      client: 'penge-passport-ph@test',
      uptime: () => null,
      now: t.now,
      stats: createStats(kv, log, t.now),
    };
    for (const email of ['ana@example.com', 'ben@example.com']) {
      await confirm(kv, keys, await createPending(kv, keys, { email, siteIds: [486], applicants: 1, pace: 'asap', channels: null }, t.now()), t.now());
    }
    await runCheck({ ...deps, runId: 'run1' });
    t.advance(10 * 60_000);
    upstream.open.set('486', ['2026-10-05']);
    await runCheck({ ...deps, runId: 'run2' });
    await deps.stats!.settled();
    const numbers = await dailyStats(kv, manilaDay(t.now()), t.now());
    expect(mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(1);
    expect(numbers.counts).toMatchObject({ alertsSent: 1, alertsCapped: 0, mailLimitHits: 1 });
    expect(numbers.mailLimit).toBe(1);
    // A later day, which no run enforced a limit on, has none to show.
    expect((await dailyStats(kv, manilaDay(t.now() + 86_400_000), t.now())).mailLimit).toBeNull();
  });

  it('still sends alerts when the day\'s limit cannot be noted for the report', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    const realSet = kv.set.bind(kv);
    kv.set = async (key, value, opts) => {
      if (key.startsWith(K.mailLimit(''))) throw new Error('valkey went away');
      return realSet(key, value, opts);
    };
    const { log } = recordingLog();
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
      alertsPerSubscriberPerDay: 288,
      client: 'penge-passport-ph@test',
      uptime: () => null,
      now: t.now,
      stats: createStats(kv, log, t.now),
    };
    await confirm(kv, keys, await createPending(kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: null }, t.now()), t.now());
    await runCheck({ ...deps, runId: 'run1' });
    t.advance(10 * 60_000);
    upstream.open.set('486', ['2026-10-05']);
    await runCheck({ ...deps, runId: 'run2' });
    expect(mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(1);
    expect((await dailyStats(kv, manilaDay(t.now()), t.now())).mailLimit).toBeNull();
  });

  async function limitWorld(start?: number) {
    const t = clock(start);
    const kv = new MemoryKv(t.now);
    const { log } = recordingLog();
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
      alertsPerSubscriberPerDay: 288,
      client: 'penge-passport-ph@test',
      uptime: () => null,
      now: t.now,
      stats: createStats(kv, log, t.now),
    };
    await confirm(kv, keys, await createPending(kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: null }, t.now()), t.now());
    let n = 0;
    const run = async (mailDailyLimit: number, dates: string[], alertsPerSubscriberPerDay = 288) => {
      upstream.open.set('486', dates);
      await runCheck({ ...deps, mailDailyLimit, alertsPerSubscriberPerDay, runId: `run${++n}` });
      await deps.stats!.settled();
      t.advance(10 * 60_000);
    };
    const limit = async () => (await dailyStats(kv, manilaDay(t.now() - 10 * 60_000), t.now())).mailLimit;
    return { run, limit, mailer, t, kv };
  }

  it('reports the highest limit in force that day, so lowering it later does not show more sent than allowed', async () => {
    const w = await limitWorld();
    await w.run(5, []);
    await w.run(5, ['2026-10-05']); // an alert, charged under a limit of 5
    expect(await w.limit()).toBe(5);
    await w.run(1, ['2026-10-05', '2026-10-06']); // the limit lowered: this one is stopped, and the day's limit stays 5
    expect(w.mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(1);
    expect(await w.limit()).toBe(5);
    await w.run(50, ['2026-10-05', '2026-10-06', '2026-10-07']); // raised later in the day
    expect(await w.limit()).toBe(50);
  });

  // 23:59:58 in Manila on 27 September, 2 seconds before the new day, after a run that sees nothing.
  async function justBeforeMidnight() {
    const w = await limitWorld(Date.parse('2026-09-27T15:30:00Z'));
    await w.run(300, []); // baseline; the clock is now 15:40
    return w;
  }
  const countsOn = async (kv: MemoryKv, day: string, now: number) => (await dailyStats(kv, day, now)).counts;

  it('counts a limit stop under the day of its charge, though the run goes on past midnight', async () => {
    const w = await justBeforeMidnight();
    w.t.advance(19 * 60_000 + 58_000); // 15:59:58
    const write = w.kv.write.bind(w.kv);
    w.kv.write = async (ops) => {
      if (ops.some((o) => o.op === 'decr')) w.t.advance(5000); // the stop's own write: midnight passes
      return write(ops);
    };
    await w.run(0, ['2026-10-05']);
    expect((await countsOn(w.kv, '2026-09-27', w.t.now())).mailLimitHits).toBe(1);
    expect((await countsOn(w.kv, '2026-09-28', w.t.now())).mailLimitHits).toBe(0);
  });

  it('counts an alert sent after midnight under the day its allowance was charged', async () => {
    const w = await justBeforeMidnight();
    w.t.advance(19 * 60_000 + 58_000);
    const send = w.mailer.send.bind(w.mailer);
    w.mailer.send = async (mail) => {
      w.t.advance(5000); // the send takes until after midnight
      return send(mail);
    };
    await w.run(300, ['2026-10-05']);
    expect((await countsOn(w.kv, '2026-09-27', w.t.now())).alertsSent).toBe(1);
    expect((await countsOn(w.kv, '2026-09-28', w.t.now())).alertsSent).toBe(0);
  });

  it("counts a person's own cap under the day it was checked against, though midnight passes while it is read", async () => {
    const w = await justBeforeMidnight();
    await w.run(300, ['2026-10-05'], 1); // ana's one alert for the day, at 15:40
    w.t.advance(9 * 60_000 + 58_000); // 15:59:58
    const get = w.kv.get.bind(w.kv);
    w.kv.get = async (key) => {
      const value = await get(key);
      if (key.includes(':alerts:')) w.t.advance(5000); // read just before midnight, answered after
      return value;
    };
    await w.run(300, ['2026-10-05', '2026-10-06'], 1);
    expect((await countsOn(w.kv, '2026-09-27', w.t.now())).alertsCapped).toBe(1);
    expect((await countsOn(w.kv, '2026-09-28', w.t.now())).alertsCapped).toBe(0);
  });

  it("notes the day's limit at a later charge when the first attempt failed", async () => {
    const w = await limitWorld();
    await confirm(w.kv, keys, await createPending(w.kv, keys, { email: 'ben@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: null }, w.t.now()), w.t.now());
    await w.run(300, []);
    const set = w.kv.set.bind(w.kv);
    let failures = 1;
    w.kv.set = async (key, value, opts) => {
      if (key.startsWith(K.mailLimit('')) && failures-- > 0) throw new Error('valkey blinked');
      return set(key, value, opts);
    };
    await w.run(300, ['2026-10-05']); // two alerts in one run: the first note fails, the second succeeds
    expect(w.mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(2);
    expect(await w.limit()).toBe(300);
  });

  it('reports a limit of zero as zero, not as unknown', async () => {
    const w = await limitWorld();
    await w.run(0, []);
    await w.run(0, ['2026-10-05']);
    expect(w.mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(0);
    expect(await w.limit()).toBe(0);
    expect(dailyStatsEmail({ ...base0, mailLimit: 0 }).text).toContain('Alerts sent: 0 of 0 allowed a day');
  });
});

const base0 = {
  schema: 1 as const,
  day: '2026-10-03',
  partialFrom: null,
  visitors: 0,
  abroadVisitors: 0,
  topOffices: [],
  subscribers: 0,
  generatedAt: '2026-10-03T23:30:00.000Z',
  counts: Object.fromEntries(COUNTS.map((n) => [n, 0])) as Record<Count, number>,
};describe("the operator's daily email", () => {
  const base = {
    schema: 1 as const,
    day: '2026-10-03',
    partialFrom: null,
    visitors: 187,
    abroadVisitors: 37,
    topOffices: [],
    subscribers: 43,
    generatedAt: '2026-10-03T23:30:00.000Z',
    counts: Object.fromEntries(COUNTS.map((n) => [n, 0])) as Record<Count, number>,
  };

  it('says how much of the daily email limit was used, and how often it stopped a run', () => {
    const counts = { ...base.counts, alertsSent: 300, mailLimitHits: 24 };
    const mail = dailyStatsEmail({ ...base, counts, mailLimit: 2500 });
    expect(mail.text).toContain('Alerts sent: 300 of 2,500 allowed a day');
    expect(mail.text).toContain('Runs stopped by the daily email limit: 24');
    expect(mail.text).toContain("Alerts held back by a person's own daily cap: 0");
    expect(mail.html).toContain('300 of 2,500 allowed a day');
  });

  it('shows the plain count when the limit is not known', () => {
    const mail = dailyStatsEmail({ ...base, counts: { ...base.counts, alertsSent: 7 }, mailLimit: null });
    expect(mail.text).toContain('Alerts sent: 7\n');
  });
});
