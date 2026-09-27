import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { exportSubscribers, importSubscribers } from '../src/backup.ts';
import { ANNOUNCE_WINDOW_SECONDS, type CheckDeps, COOLDOWN_ERRORS, COOLDOWN_SECONDS, deliver, MAX_SITES, MIN_KEPT_FRACTION, openJob, OUTBOX_MAX_AGE_MS, RETRY_CAP, runCheck, SCAN_BUDGET_MS, sealJob } from '../src/checker.ts';
import { K, manilaDay } from '../src/keys.ts';
import type { Logger } from '../src/log.ts';
import { confirm, createPending } from '../src/subscribers.ts';
import { formatDate } from '../src/templates.ts';
import { clock, FakeMailer, FakeUpstream, keys, MemoryKv, MemorySink, PUBLISHED } from './helpers.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 200) / 2;

function recordingLog() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m, f) => lines.push(JSON.stringify({ m, f })),
    warn: (m, f) => lines.push(JSON.stringify({ m, f })),
    error: (m, f) => lines.push(JSON.stringify({ m, f })),
  };
  return { log, lines };
}

async function world(overrides: Partial<CheckDeps> = {}) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  const upstream = new FakeUpstream();
  const sink = new MemorySink();
  const mailer = new FakeMailer();
  const { log, lines } = recordingLog();
  const deps: CheckDeps = {
    kv,
    upstream,
    sink,
    mailer,
    keys,
    log,
    publicBaseUrl: 'https://penge.example',
    mailDailyLimit: 300,
    alertsPerSubscriberPerDay: 3,
    client: 'penge-passport-ph@test',
    now: t.now,
    ...overrides,
  };
  let n = 0;
  const subscribe = async (email: string, siteIds: number[], applicants = 1) => {
    const token = await createPending(kv, keys, { email, siteIds, applicants }, t.now());
    const result = await confirm(kv, token, t.now());
    if (result.status === 'invalid') throw new Error('confirm failed');
    return result.subscriberId;
  };
  const run = async () => {
    const report = await runCheck({ ...deps, runId: `run${++n}` });
    t.advance(10 * 60_000);
    return report;
  };
  return { t, kv, upstream, sink, mailer, deps, lines, subscribe, run };
}

describe('checker', () => {
  it('treats the first run as a baseline, then alerts only for dates that open', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.subscribe('ben@example.com', [693]);
    w.upstream.open.set('486', ['2026-10-05']);

    const first = await w.run();
    expect(first).toMatchObject({ healthy: true, queued: 0, uploaded: true });
    expect(w.mailer.sent).toHaveLength(0);
    expect(w.sink.scans[0]!.sites).toHaveLength(5);
    const status = JSON.parse((await w.kv.get(K.status))!);
    expect(status.sites.find((s: { id: number }) => s.id === 486).openDates).toEqual(['2026-10-05']);
    expect(JSON.parse((await w.kv.get(K.sites))!)).toHaveLength(5);

    w.upstream.open.set('486', ['2026-10-05', '2026-10-07']);
    const second = await w.run();
    expect(second.queued).toBe(1);
    expect(second.delivery).toMatchObject({ sent: 1, remaining: 0 });
    const mail = w.mailer.sent[0]!;
    expect(mail.to).toBe('ana@example.com');
    expect(mail.kind).toBe('alert');
    expect(mail.subject).toBe('Passport dates open: Antipolo');
    expect(mail.text).toContain('Wed 7 Oct 2026');
    expect(mail.text).not.toContain('Mon 5 Oct 2026');
    expect(mail.unsubscribeUrl).toMatch(/^https:\/\/penge\.example\/api\/unsubscribe\?token=/);
    expect(mail.text).toMatch(/Stop all alerts: https:\/\/penge\.example\/unsubscribe#token=/);

    // Nothing new: nothing sent.
    expect((await w.run()).queued).toBe(0);
  });

  it('sends nothing and keeps every baseline when the scan is unhealthy', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();

    // Two of five sites failing is past the 20% line.
    w.upstream.failing = new Set([10, 20]);
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    const bad = await w.run();
    expect(bad.healthy).toBe(false);
    expect(bad.problems).toContain('2 of 5 sites failed');
    expect(bad.queued).toBe(0);
    expect(w.mailer.sent).toHaveLength(0);
    expect(await w.kv.hGetAll(K.openDates(486))).toEqual({ '1': '["2026-10-05"]' });
    const status = JSON.parse((await w.kv.get(K.status))!);
    expect(status.healthy).toBe(false);
    expect(status.sites.find((s: { id: number }) => s.id === 486).openDates).toEqual(['2026-10-05']);
    // The scan is still stored, for analysis.
    expect(w.sink.scans.at(-1)!.healthy).toBe(false);

    w.upstream.failing.clear();
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    expect(w.mailer.sent[0]!.text).toContain('Tue 6 Oct 2026');
  });

  it.each([
    ['the site list fails', (u: FakeUpstream) => void (u.sitesError = new Error('500'))],
    ['no site publishes dates', (u: FakeUpstream) => { for (const id of [10, 20, 30, 486, 693]) u.published.set(id, []); }],
    ['the site list is empty', (u: FakeUpstream) => void (u.sitesList = [])],
  ])('is unhealthy when %s', async (_, breakIt) => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    breakIt(w.upstream);
    w.upstream.open.set('486', ['2026-10-05']);
    const report = await w.run();
    expect(report.healthy).toBe(false);
    expect(w.mailer.sent).toHaveLength(0);
  });

  it('keeps the baseline of a site that failed or went blank, so its return is not news', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run();

    w.upstream.failing.add(486); // 1 of 5: the run is still healthy
    expect((await w.run()).healthy).toBe(true);
    w.upstream.failing.clear();
    w.upstream.published.set(486, []);
    expect((await w.run()).healthy).toBe(true);
    w.upstream.published.delete(486);
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
  });

  it('announces a flickering date once per window', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    const flip = async (open: string[]) => {
      w.upstream.open.set('486', open);
      await w.run();
    };
    await flip(['2026-10-05']);
    await flip([]);
    await flip(['2026-10-05']);
    expect(w.mailer.sent).toHaveLength(1);
    await flip([]);
    w.t.advance(ANNOUNCE_WINDOW_SECONDS * 1000);
    await flip(['2026-10-05']);
    expect(w.mailer.sent).toHaveLength(2);
  });

  it('caps alerts per subscriber per day and says when the last one goes', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    for (const date of PUBLISHED) {
      w.upstream.open.set('486', [date]);
      await w.run();
    }
    expect(w.mailer.sent).toHaveLength(3);
    expect(w.mailer.sent[1]!.text).not.toContain('last alert today');
    expect(w.mailer.sent[2]!.text).toContain('last alert today');
  });

  it('stops at the daily email limit and keeps the rest for later', async () => {
    const w = await world({ mailDailyLimit: 1 });
    await w.subscribe('ana@example.com', [486]);
    await w.subscribe('ben@example.com', [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    const report = await w.run();
    expect(report.delivery).toMatchObject({ sent: 1, remaining: 1, stoppedBy: 'daily limit' });
  });

  it('drops alerts that waited too long', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.upstream.open.set('486', ['2026-10-05']);
    expect((await w.run()).delivery).toMatchObject({ stoppedBy: 'paused', remaining: 1 });
    await w.kv.write([{ op: 'del', key: K.mailPaused }]);
    w.t.advance(OUTBOX_MAX_AGE_MS);
    expect(await deliver(w.deps)).toMatchObject({ dropped: 1, sent: 0, remaining: 0 });
  });

  it('stops after three mail failures in a row and retries later', async () => {
    const w = await world();
    for (const name of ['a', 'b', 'c', 'd']) await w.subscribe(`${name}@example.com`, [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    w.mailer.failNext = 3;
    const report = await w.run();
    expect(report.delivery).toMatchObject({ failed: 3, stoppedBy: 'mail errors', remaining: 4 });
    // A refused email costs nobody their daily allowance, nor the daily total.
    const day = manilaDay(w.t.now());
    expect(Number((await w.kv.get(K.mailSentToday(day))) ?? 0)).toBe(0);
    expect((await deliver(w.deps)).sent).toBe(4);
    expect(Number(await w.kv.get(K.mailSentToday(day)))).toBe(4);
  });

  it('never sends again an email that may already have gone out, and keeps it charged', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    w.mailer.uncertainNext = 1; // the connection drops part-way through the send
    const report = await w.run();
    expect(report.delivery).toMatchObject({ failed: 1, remaining: 0 });
    await deliver(w.deps);
    expect(w.mailer.sent).toHaveLength(0); // no second copy
    expect(Number(await w.kv.get(K.alertsToday(id, manilaDay(w.t.now()))))).toBe(1);
  });

  it('charges a subscriber\'s daily allowance only for emails actually sent', async () => {
    const w = await world({ alertsPerSubscriberPerDay: 1 });
    const id = await w.subscribe('ana@example.com', [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    w.mailer.failNext = 2;
    await w.run();
    await deliver(w.deps);
    await deliver(w.deps); // the third attempt goes through
    expect(w.mailer.sent).toHaveLength(1);
    expect(Number(await w.kv.get(K.alertsToday(id, manilaDay(w.t.now()))))).toBe(1);
  });

  it('checks group sizes separately, and only where there is room for one', async () => {
    const w = await world();
    await w.subscribe('solo@example.com', [486]);
    await w.subscribe('family@example.com', [486, 693], 4);
    await w.run();
    expect(w.upstream.calls.filter((c) => c.endsWith(':4'))).toEqual([]);

    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    w.upstream.open.set('486:4', ['2026-10-06']);
    await w.run();
    expect(w.upstream.calls).toContain('486:4');
    const byTo = Object.fromEntries(w.mailer.sent.map((m) => [m.to, m.text]));
    expect(byTo['solo@example.com']).toContain('Mon 5 Oct 2026');
    expect(byTo['family@example.com']).toContain('Tue 6 Oct 2026');
    expect(byTo['family@example.com']).not.toContain('Mon 5 Oct 2026');
    expect(byTo['family@example.com']).toContain('4 people');
  });

  it('does not let a failed group lookup turn into a false alert later', async () => {
    const w = await world();
    await w.subscribe('family@example.com', [486], 3);
    await w.run(); // 486 has no room: group baseline is known to be empty
    w.upstream.open.set('486', ['2026-10-05']);
    w.upstream.open.set('486:3', ['2026-10-05']);
    const failing = w.upstream.availability.bind(w.upstream);
    w.upstream.availability = async (q) => {
      if (q.applicants === 3) throw new Error('group lookup failed');
      return failing(q);
    };
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
    w.upstream.availability = failing;
    await w.run();
    // The empty baseline was carried forward, so the opening is still news.
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('stops scanning when the rate limiter opens its circuit', async () => {
    const w = await world();
    w.upstream.circuitAt = 486; // the second of five sites
    const report = await w.run();
    expect(report.healthy).toBe(false);
    const scan = w.sink.scans[0]!;
    expect(scan.sites.filter((s) => s.error?.startsWith('skipped')).map((s) => s.id)).toEqual([693, 20, 30]);
    expect(w.upstream.calls).toEqual(['sites', '10:1', '486:1']);
  });

  it('runs one check at a time', async () => {
    const w = await world();
    await w.kv.set(K.checkLock, 'someone-else', { ttlSeconds: 60 });
    expect((await w.run()).skipped).toBe('locked');
    expect(w.upstream.calls).toEqual([]);
  });

  it('skips people who unsubscribed while their alert waited', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486]);
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    await w.kv.write([{ op: 'del', key: K.subscriber(id) }, { op: 'del', key: K.mailPaused }]);
    expect(await deliver(w.deps)).toMatchObject({ skipped: 1, sent: 0 });
  });

  it('never logs an address', async () => {
    const w = await world();
    await w.subscribe('secret.person@example.com', [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    w.mailer.failNext = 1;
    await w.run();
    await deliver(w.deps);
    expect(w.mailer.sent).toHaveLength(1);
    expect(w.lines.join('\n')).not.toContain('secret.person');
  });

  it('keeps the daily caps on Manila days', () => {
    expect(manilaDay(Date.parse('2026-09-27T15:59:59Z'))).toBe('2026-09-27');
    expect(manilaDay(Date.parse('2026-09-27T16:00:00Z'))).toBe('2026-09-28');
  });
});

describe('checker, found by adversarial review', () => {
  it('loses no alert when the process dies while committing', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    // The commit (the write that queues alerts) fails once, as if the process died there.
    const write = w.kv.write.bind(w.kv);
    let failed = false;
    w.kv.write = async (ops) => {
      if (!failed && ops.some((o) => o.op === 'rPush' && o.key === K.outbox)) {
        failed = true;
        throw new Error('killed');
      }
      return write(ops);
    };
    await expect(w.run()).rejects.toThrow('killed');
    expect(w.mailer.sent).toHaveLength(0);
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('creates one subscriber when two confirmations for one address race', async () => {
    const w = await world();
    const a = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1 }, w.t.now());
    const b = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [693], applicants: 1 }, w.t.now());
    const results = await Promise.all([confirm(w.kv, a, w.t.now()), confirm(w.kv, b, w.t.now())]);
    const ids = new Set(results.map((r) => (r.status === 'invalid' ? null : r.subscriberId)));
    expect(ids.size).toBe(1);
    const members = [...(await w.kv.sMembers(K.siteSubscribers(486))), ...(await w.kv.sMembers(K.siteSubscribers(693)))];
    expect(new Set(members).size).toBe(1);
    expect(w.kv.keys().filter((k) => k.startsWith('pp:sub:'))).toHaveLength(1);
  });

  it('keeps a confirmation link working when the address is busy, and single-use once it works', async () => {
    const w = await world();
    const token = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1 }, w.t.now());
    const pending = JSON.parse((await w.kv.get(w.kv.keys().find((k) => k.startsWith('pp:pending:'))!))!) as { index: string };
    await w.kv.set(K.addressLock(pending.index), 'someone-else', { ttlSeconds: 60 });
    await expect(confirm(w.kv, token, w.t.now())).rejects.toThrow('busy');
    await w.kv.write([{ op: 'del', key: K.addressLock(pending.index) }]);
    expect((await confirm(w.kv, token, w.t.now())).status).toBe('confirmed');
    expect((await confirm(w.kv, token, w.t.now())).status).toBe('invalid');
    const twice = await createPending(w.kv, keys, { email: 'bo@example.com', siteIds: [486], applicants: 1 }, w.t.now());
    const both = await Promise.all([confirm(w.kv, twice, w.t.now()), confirm(w.kv, twice, w.t.now())]);
    expect(both.map((r) => r.status).sort()).toEqual(['confirmed', 'invalid']);
  }, 15_000);

  it('does not spend a subscriber\'s allowance while the daily limit holds their alert back', async () => {
    const w = await world({ mailDailyLimit: 0 });
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    for (let i = 0; i < 5; i++) await deliver(w.deps);
    expect(await w.kv.lLen(K.outbox)).toBe(1);
    expect(w.kv.keys().filter((k) => k.startsWith('pp:alerts:'))).toEqual([]);
  });

  it('refuses an implausibly long office list without scanning it', async () => {
    const w = await world();
    await w.run();
    const before = await w.kv.get(K.sites);
    w.upstream.sitesList = Array.from({ length: MAX_SITES + 1 }, (_, i) => ({ ...w.upstream.sitesList[0]!, id: 1000 + i }));
    w.upstream.calls = [];
    const report = await w.run();
    expect(report.healthy).toBe(false);
    expect(w.upstream.calls).toEqual(['sites']);
    expect(await w.kv.get(K.sites)).toBe(before);
  });

  it('publishes each office\'s phone and map link only when they are real', async () => {
    const w = await world();
    const [a, b] = w.upstream.sitesList;
    w.upstream.sitesList = [
      { ...a!, telephone: '(02) 8651-9400', mapUrl: 'https://maps.app.goo.gl/J4tPkGDgNSjURhQn7' },
      { ...b!, telephone: '0000', mapUrl: 'javascript:alert(1)' },
      ...w.upstream.sitesList.slice(2),
    ];
    await w.run();
    const status = JSON.parse((await w.kv.get(K.status))!) as { sites: { id: number; telephone: string | null; mapUrl: string | null }[] };
    const byId = new Map(status.sites.map((s) => [s.id, s]));
    expect(byId.get(a!.id)).toMatchObject({ telephone: '(02) 8651-9400', mapUrl: 'https://maps.app.goo.gl/J4tPkGDgNSjURhQn7' });
    expect(byId.get(b!.id)).toMatchObject({ telephone: null, mapUrl: null });
  });

  it('tries an office once more when it answers with an error, and keeps its dates', async () => {
    const w = await world();
    w.upstream.open.set('486', ['2026-10-05']);
    w.upstream.failOnce.add(486);
    expect((await w.run()).healthy).toBe(true);
    expect(w.upstream.calls.filter((c) => c === '486:1')).toHaveLength(2);
    const status = JSON.parse((await w.kv.get(K.status))!) as { sites: { id: number; ok: boolean; openDates: string[] }[] };
    expect(status.sites.find((s) => s.id === 486)).toMatchObject({ ok: true, openDates: ['2026-10-05'] });
  });

  it(`tries at most ${RETRY_CAP} offices again, and shows a failed office as last known, with when that was`, async () => {
    const w = await world();
    await w.run();
    type Row = { id: number; ok: boolean; checkedAt?: string | null };
    const read = async () => (JSON.parse((await w.kv.get(K.status))!) as { sites: Row[] }).sites;
    const known = (await read()).find((s) => s.id === 486)!;
    expect(known.checkedAt).toMatch(/^\d{4}-/);

    w.upstream.failing.add(486);
    w.upstream.calls = [];
    await w.run();
    expect(w.upstream.calls.filter((c) => c === '486:1')).toHaveLength(2);
    expect((await read()).find((s) => s.id === 486)).toMatchObject({ ok: false, checkedAt: known.checkedAt });

    const ids = w.upstream.sitesList.map((s) => s.id);
    for (const id of ids) w.upstream.failing.add(id);
    w.upstream.calls = [];
    await w.run();
    expect(w.upstream.calls.filter((c) => c.endsWith(':1'))).toHaveLength(ids.length + RETRY_CAP);
  });

  it('rests after a scan the site struggled with, then scans again', async () => {
    const w = await world();
    const ids = w.upstream.sitesList.map((s) => s.id);
    for (const id of ids.slice(0, COOLDOWN_ERRORS)) w.upstream.failing.add(id);
    await runCheck({ ...w.deps, runId: 'struggled' });
    w.upstream.failing.clear();
    w.upstream.calls = [];
    w.t.advance(5 * 60_000); // the next scan is due
    expect((await runCheck({ ...w.deps, runId: 'rests' })).skipped).toBe('cooling down');
    expect(w.upstream.calls).toEqual([]); // not one request while resting
    w.t.advance(COOLDOWN_SECONDS * 1000);
    expect((await runCheck({ ...w.deps, runId: 'back' })).skipped).toBeNull();

    // A single office answering with an error is not the site struggling.
    w.upstream.failing.add(ids[0]!);
    w.t.advance(5 * 60_000);
    await runCheck({ ...w.deps, runId: 'one-error' });
    w.t.advance(5 * 60_000);
    expect((await runCheck({ ...w.deps, runId: 'next' })).skipped).toBeNull();
  });

  it('distrusts an office list cut short, and keeps the last good one', async () => {
    const w = await world();
    await w.run();
    const all = w.upstream.sitesList;
    const before = await w.kv.get(K.sites);
    const statusBefore = JSON.parse((await w.kv.get(K.status))!) as { sites: unknown[] };
    // Losing more than a fifth of the offices at once looks like a fault, not closures.
    w.upstream.sitesList = all.slice(0, Math.ceil(all.length * MIN_KEPT_FRACTION) - 1);
    const report = await w.run();
    expect(report.healthy).toBe(false);
    expect(report.problems).toContain(`the site list shrank from ${all.length} to ${w.upstream.sitesList.length} offices`);
    expect(await w.kv.get(K.sites)).toBe(before);
    expect((JSON.parse((await w.kv.get(K.status))!) as { sites: unknown[] }).sites).toEqual(statusBefore.sites);
    // One office closing is a real change.
    w.upstream.sitesList = all.slice(1);
    expect((await w.run()).healthy).toBe(true);
    expect((JSON.parse((await w.kv.get(K.sites))!) as unknown[]).length).toBe(all.length - 1);
  });

  it('stops scanning when the run takes too long', async () => {
    const w = await world();
    const slow = w.upstream.availability.bind(w.upstream);
    w.upstream.availability = async (q) => {
      w.t.advance(SCAN_BUDGET_MS / 2);
      return slow(q);
    };
    const report = await w.run();
    expect(report.healthy).toBe(false);
    expect(w.sink.scans[0]!.sites.filter((s) => s.error === 'skipped: the scan ran out of time')).toHaveLength(2);
  });

  it('drops the parts of a waiting alert that no longer match the subscription', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    await w.subscribe('ana@example.com', [693]); // changes offices while the alert waits
    await w.kv.write([{ op: 'del', key: K.mailPaused }]);
    expect(await deliver(w.deps)).toMatchObject({ skipped: 1, sent: 0 });
  });

  it('stops a run that lost its lock to another checker', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    const real = w.upstream.availability.bind(w.upstream);
    w.upstream.availability = async (q) => {
      await w.kv.set(K.checkLock, 'another-checker', { ttlSeconds: 60 });
      return real(q);
    };
    await expect(w.run()).rejects.toThrow('lost the checker lock');
    expect(await w.kv.get(K.checkLock)).toBe('another-checker');
    expect(w.sink.scans).toHaveLength(0);
  });

  it('honours a pause set in the middle of delivery', async () => {
    const w = await world();
    for (const name of ['a', 'b', 'c']) await w.subscribe(`${name}@example.com`, [486]);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    const send = w.mailer.send.bind(w.mailer);
    w.mailer.send = async (mail) => {
      const result = await send(mail);
      await w.kv.set(K.mailPaused, '1');
      return result;
    };
    const report = await w.run();
    expect(report.delivery).toMatchObject({ sent: 1, stoppedBy: 'paused', remaining: 2 });
  });
});

describe('outbox integrity and backups', () => {
  it('drops an alert that was altered in Redis instead of sending it', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486]);
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    const raw = (await w.kv.lPop(K.outbox))!;
    const job = openJob(raw, keys.token)!;
    expect(job.openings[0]!.name).toContain('Antipolo');
    const forged = JSON.parse(raw) as { job: string; mac: string };
    forged.job = forged.job.replace('Antipolo', 'Visit evil.example to book');
    await w.kv.write([
      { op: 'rPush', key: K.outbox, values: [JSON.stringify(forged)] },
      { op: 'rPush', key: K.outbox, values: [JSON.stringify(job)] }, // unsigned
      { op: 'del', key: K.mailPaused },
    ]);
    expect(await deliver(w.deps)).toMatchObject({ dropped: 2, sent: 0 });
    // The genuine one still goes.
    await w.kv.write([{ op: 'rPush', key: K.outbox, values: [sealJob(job, keys.token)] }]);
    expect(await deliver(w.deps)).toMatchObject({ sent: 1 });
  });

  it('backs subscribers up to R2 once a day, and a backup restores them', async () => {
    const puts: { key: string; body: Uint8Array }[] = [];
    const w = await world();
    w.sink.putObject = async (key, body) => void puts.push({ key, body });
    const id = await w.subscribe('ana@example.com', [486, 693], 2);
    await w.run();
    await w.run();
    expect(puts.map((p) => p.key)).toEqual(['backups/subscribers/date=2026-09-27/subscribers.json.gz']);
    const backup = JSON.parse(gunzipSync(puts[0]!.body).toString());
    expect(backup.subscribers.map((s: { id: string }) => s.id)).toEqual([id]);
    expect(JSON.stringify(backup)).not.toContain('ana@example.com');

    const fresh = new MemoryKv();
    expect(await importSubscribers(fresh, backup)).toBe(1);
    const again = await exportSubscribers(fresh, [486, 693], 0);
    expect(again.subscribers).toEqual(backup.subscribers);
    expect(await fresh.sMembers(K.siteSubscribers(693))).toEqual([id]);
    await expect(importSubscribers(fresh, { version: 1, exportedAt: '', subscribers: [{ id: '../x', fields: {} }] })).rejects.toThrow();
  });

  it('backs up a subscriber whose only office has left the DFA\'s list', async () => {
    const w = await world();
    const gone = w.upstream.sitesList[0]!.id;
    const id = await w.subscribe('ana@example.com', [gone]);
    const remaining = w.upstream.sitesList.slice(1).map((s) => s.id);
    const backup = await exportSubscribers(w.kv, remaining, 0); // the office list no longer has it
    expect(backup.subscribers.map((s) => s.id)).toEqual([id]);
    const fresh = new MemoryKv();
    await importSubscribers(fresh, backup);
    expect(await fresh.sMembers(K.allSubscribers)).toEqual([id]);
  });
});

describe('checker fuzz', () => {
  const SITE_IDS = [10, 20, 30, 486, 693];
  const step = fc.record({
    open: fc.array(fc.subarray(PUBLISHED), { minLength: 5, maxLength: 5 }),
    failing: fc.subarray(SITE_IDS),
    blank: fc.subarray(SITE_IDS, { maxLength: 1 }),
    minutes: fc.constantFrom(10, 10, 30, 200),
  });

  it('only ever announces dates that are open now and were not open at the last good look', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 2, maxLength: 12 }), async (steps) => {
        const w = await world({ alertsPerSubscriberPerDay: 50 });
        const people = new Map<string, number>();
        for (const id of SITE_IDS) people.set(`p${id}@example.com`, id);
        for (const [email, id] of people) await w.subscribe(email, [id]);

        const lastGood = new Map<number, Set<string>>();
        const lastAnnounced = new Map<string, number>();
        for (const s of steps) {
          SITE_IDS.forEach((id, i) => w.upstream.open.set(String(id), s.open[i]!));
          w.upstream.failing = new Set(s.failing);
          w.upstream.published = new Map(s.blank.map((id) => [id, []]));
          const before = w.mailer.sent.length;
          const report = await runCheck({ ...w.deps, runId: `r${w.t.now()}` });
          const mails = w.mailer.sent.slice(before);

          if (!report.healthy) expect(mails).toEqual([]);
          for (const mail of mails) {
            const siteId = people.get(mail.to)!;
            const openNow = new Set(w.upstream.open.get(String(siteId)));
            const good = lastGood.get(siteId);
            expect(good).toBeDefined(); // never on a first look
            const dates = [...mail.text.matchAll(/ {2}- (\w{3} \d+ \w{3} \d{4})/g)].map((m) => m[1]);
            expect(dates.length).toBeGreaterThan(0);
            for (const date of PUBLISHED) {
              if (!dates.includes(formatDate(date))) continue;
              expect(openNow.has(date)).toBe(true);
              expect(good!.has(date)).toBe(false);
              const key = `${siteId}:${date}`;
              const last = lastAnnounced.get(key);
              if (last !== undefined) expect(w.t.now() - last).toBeGreaterThanOrEqual(ANNOUNCE_WINDOW_SECONDS * 1000);
              lastAnnounced.set(key, w.t.now());
            }
          }
          if (report.healthy) {
            for (const id of SITE_IDS) {
              if (!s.failing.includes(id) && !s.blank.includes(id)) lastGood.set(id, new Set(w.upstream.open.get(String(id))));
            }
          }
          w.t.advance(s.minutes * 60_000);
        }
      }),
      { seed: 20260927, numRuns: RUNS },
    );
  }, 10_000 + RUNS * 10);
});
