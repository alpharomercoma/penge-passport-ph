import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { exportSubscribers, importSubscribers } from '../src/backup.ts';
import { ANNOUNCE_WINDOW_SECONDS, type CheckDeps, COOLDOWN_ERRORS, COOLDOWN_SECONDS, deliver, MAX_SITES, MIN_KEPT_FRACTION, openJob, OUTBOX_MAX_AGE_MS, PACE_SPACING_MS, RETRY_CAP, runCheck, SCAN_BUDGET_MS, sealJob } from '../src/checker.ts';
import type { Pace } from '@penge/contracts';
import { parseStamp } from '../src/clock.ts';
import { K, manilaDay } from '../src/keys.ts';
import type { Logger } from '../src/log.ts';
import { confirm, createPending, unsubscribe } from '../src/subscribers.ts';
import { signUnsubscribe } from '../src/crypto.ts';
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
    // The fake clock, not this machine's uptime (Linux has one, macOS does not): the same on every machine.
    uptime: () => null,
    now: t.now,
    ...overrides,
  };
  let n = 0;
  // Most tests here want an email at every check: the "asap" pace. Pace itself is tested below.
  const subscribe = async (email: string, siteIds: number[], applicants = 1, pace: Pace = 'asap') => {
    const token = await createPending(kv, keys, { email, siteIds, applicants, pace }, t.now());
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
    expect(report.delivery).toMatchObject({ sent: 1, remaining: 0, held: 1, stoppedBy: 'daily limit' });
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
    // The three refused wait with their people; the fourth never left the outbox.
    expect(report.delivery).toMatchObject({ failed: 3, stoppedBy: 'mail errors', remaining: 1, held: 3 });
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
    const a = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'hourly' }, w.t.now());
    const b = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [693], applicants: 1, pace: 'hourly' }, w.t.now());
    const results = await Promise.all([confirm(w.kv, a, w.t.now()), confirm(w.kv, b, w.t.now())]);
    const ids = new Set(results.map((r) => (r.status === 'invalid' ? null : r.subscriberId)));
    expect(ids.size).toBe(1);
    const members = [...(await w.kv.sMembers(K.siteSubscribers(486))), ...(await w.kv.sMembers(K.siteSubscribers(693)))];
    expect(new Set(members).size).toBe(1);
    expect(w.kv.keys().filter((k) => k.startsWith('pp:sub:'))).toHaveLength(1);
  });

  it('cancels confirmation links still waiting when the address unsubscribes', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486]);
    // Ana asks to change her offices, then unsubscribes from an older alert before confirming.
    const update = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [693], applicants: 1, pace: 'hourly' }, w.t.now());
    expect(await unsubscribe(w.kv, keys, signUnsubscribe(id, keys.token))).toBe(true);
    expect((await confirm(w.kv, update, w.t.now())).status).toBe('invalid'); // no way back in by an old link
    expect(w.kv.keys().filter((k) => k.startsWith('pp:pending'))).toEqual([]);
    expect(w.kv.keys().filter((k) => k.startsWith('pp:sub'))).toEqual([]);
  });

  it('keeps a confirmation link working when the address is busy, and single-use once it works', async () => {
    const w = await world();
    const token = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'hourly' }, w.t.now());
    const pending = JSON.parse((await w.kv.get(w.kv.keys().find((k) => k.startsWith('pp:pending:'))!))!) as { index: string };
    await w.kv.set(K.addressLock(pending.index), 'someone-else', { ttlSeconds: 60 });
    await expect(confirm(w.kv, token, w.t.now())).rejects.toThrow('busy');
    await w.kv.write([{ op: 'del', key: K.addressLock(pending.index) }]);
    expect((await confirm(w.kv, token, w.t.now())).status).toBe('confirmed');
    expect((await confirm(w.kv, token, w.t.now())).status).toBe('invalid');
    const twice = await createPending(w.kv, keys, { email: 'bo@example.com', siteIds: [486], applicants: 1, pace: 'hourly' }, w.t.now());
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
    expect(await w.kv.sMembers(K.heldSubscribers)).toHaveLength(1);
    expect(await w.kv.lLen(K.outbox)).toBe(0);
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
    const deleted: string[] = [];
    w.sink.deleteObject = async (key) => void deleted.push(key);
    const stored = ['2026-07-01', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-26'].map((d) => `backups/subscribers/date=${d}/subscribers.json.gz`);
    w.sink.listObjects = async (prefix) => (prefix === 'backups/subscribers/' ? stored : []);
    const id = await w.subscribe('ana@example.com', [486, 693], 2);
    await w.run();
    await w.run();
    expect(puts.map((p) => p.key)).toEqual(['backups/subscribers/date=2026-09-27/subscribers.json.gz']);
    // Every copy 14 days old or older goes, however old, so an unsubscribed address leaves the backups too.
    expect(deleted).toEqual(stored.slice(0, 3)); // 1 Jul, 12 Sep and 13 Sep; 14 Sep (13 days old) stays
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

describe('pace', () => {
  const datesIn = (text: string) => [...text.matchAll(/ {2}- (\w{3} \d+ \w{3} \d{4})/g)].map((m) => m[1]);

  it('emails an hourly person at most once an hour, with everything new since the last email', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run(); // the baseline
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);

    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    expect((await w.run()).delivery).toMatchObject({ sent: 0, held: 1 }); // 10 minutes after the email
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    for (let i = 0; i < 4; i++) await w.run(); // 20 to 50 minutes after
    expect(w.mailer.sent).toHaveLength(1);

    expect((await w.run()).delivery).toMatchObject({ sent: 1, held: 0 }); // an hour after
    expect(datesIn(w.mailer.sent[1]!.text)).toEqual(['Tue 6 Oct 2026', 'Wed 7 Oct 2026']);
  });

  it('leaves out dates that closed while they waited, and still tells them if one opens again', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // 6 Oct waits
    w.upstream.open.set('486', ['2026-10-05']);
    for (let i = 0; i < 5; i++) await w.run(); // 6 Oct closes; an hour passes
    expect(w.mailer.sent).toHaveLength(1); // nothing open to tell: no email
    expect(await w.kv.sMembers(K.heldSubscribers)).toHaveLength(1); // 6 Oct waits in case it opens again

    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    await w.run(); // an hour and more since the email: 6 Oct is back, and 7 Oct is new
    expect(datesIn(w.mailer.sent[1]!.text)).toEqual(['Tue 6 Oct 2026', 'Wed 7 Oct 2026']);
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
    await w.run(); // 8 Oct waits
    w.upstream.open.set('486', ['2026-10-05', '2026-10-07', '2026-10-08']);
    for (let i = 0; i < 5; i++) await w.run();
    expect(datesIn(w.mailer.sent[2]!.text)).toEqual(['Thu 8 Oct 2026']);

    // A date that closed and stays closed is dropped once it is 3 hours old.
    w.t.advance(OUTBOX_MAX_AGE_MS);
    await w.run();
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([]);
    expect(w.mailer.sent).toHaveLength(3);
  });

  it('emails an asap person at every check, and holds a second email within the same check', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486], 1, 'asap');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run();
    expect(w.mailer.sent).toHaveLength(2);
    expect(PACE_SPACING_MS.asap).toBeLessThan(15 * 60_000); // checks start every 15 minutes

    // More in the same run (the posts abroad come minutes after): it joins the next email.
    w.t.advance(-10 * 60_000); // back to the moment of the last email
    const job = { id: 'x', createdAt: w.t.now(), subscriberId: id, applicants: 1, openings: [{ id: 486, name: 'Antipolo', dates: ['2026-10-06'] }] };
    await w.kv.write([{ op: 'rPush', key: K.outbox, values: [sealJob(job, keys.token)] }]);
    expect(await deliver(w.deps)).toMatchObject({ sent: 0, held: 1 });
  });

  it('drops a held alert that was altered, and forgets what waited on unsubscribing', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run();
    const held = JSON.parse((await w.kv.get(K.held(id)))!) as { job: string; mac: string };
    await w.kv.set(K.held(id), JSON.stringify({ ...held, job: held.job.replace('2026-10-06', '2026-10-05') }));
    w.t.advance(60 * 60_000);
    expect(await deliver(w.deps)).toMatchObject({ dropped: 1, sent: 0, held: 0 });

    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
    await w.run();
    expect(await w.kv.get(K.held(id))).not.toBeNull();
    expect(await unsubscribe(w.kv, keys, signUnsubscribe(id, keys.token))).toBe(true);
    expect(await w.kv.get(K.held(id))).toBeNull();
    expect(await w.kv.get(K.lastAlert(id))).toBeNull();
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([]);
  });

  it('keeps a person\'s pace through a change of offices and a backup', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486], 1, 'asap');
    await w.subscribe('ana@example.com', [693], 1, 'asap'); // an update keeps what they chose
    expect((await w.kv.hGetAll(K.subscriber(id))).pace).toBe('asap');
    const backup = await exportSubscribers(w.kv, [693], 0);
    const fresh = new MemoryKv();
    await importSubscribers(fresh, backup);
    expect((await fresh.hGetAll(K.subscriber(id))).pace).toBe('asap');
    backup.subscribers[0]!.fields.pace = 'daily';
    await expect(importSubscribers(new MemoryKv(), backup)).rejects.toThrow(/bad subscriber/);
    // A subscription from before paces existed is hourly.
    await w.kv.write([{ op: 'hSet', key: K.subscriber(id), fields: { pace: '' } }]);
    const { load } = await import('../src/subscribers.ts');
    expect((await load(w.kv, id))!.pace).toBe('hourly');
  });

  it('marks an alert sent before it goes out, and undoes that when the mail server refuses it', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email
    const first = await w.kv.get(K.lastAlert(id));
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    for (let i = 0; i < 5; i++) await w.run(); // 6 Oct waits for the hour

    const atSend: { last: string | null; held: string | null }[] = [];
    const send = w.mailer.send.bind(w.mailer);
    w.mailer.send = async (mail) => {
      atSend.push({ last: await w.kv.get(K.lastAlert(id)), held: await w.kv.get(K.held(id)) });
      return send(mail);
    };
    w.mailer.failNext = 1; // refused: nothing went out
    await w.run();
    expect(parseStamp(atSend[0]!.last)?.wall).toBe(w.t.now() - 10 * 60_000); // claimed first, like a popped outbox entry
    expect(atSend[0]!.held).toBeNull();
    expect(await w.kv.get(K.lastAlert(id))).toBe(first); // undone
    expect(await w.kv.get(K.held(id))).not.toBeNull();
    await w.run(); // tried again
    expect(w.mailer.sent).toHaveLength(2);
    expect(datesIn(w.mailer.sent[1]!.text)).toEqual(['Tue 6 Oct 2026']);
  });

  it('keeps closed dates waiting when the daily email limit stops a send', async () => {
    const w = await world({ mailDailyLimit: 1 });
    const id = await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the one email allowed today
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // 6 Oct waits
    w.upstream.open.set('486', ['2026-10-05', '2026-10-07']);
    for (let i = 0; i < 5; i++) await w.run(); // 6 Oct closes, 7 Oct opens; the hour passes into the limit
    const held = openJob((await w.kv.get(K.held(id)))!, keys.token)!;
    expect(held.openings.flatMap((o) => o.dates).sort()).toEqual(['2026-10-06', '2026-10-07']);
  });

  it('never sends a group a date that has no room even for one person', async () => {
    const w = await world();
    await w.subscribe('family@example.com', [486], 2, 'hourly');
    w.upstream.open.set('486', ['2026-10-05']);
    w.upstream.open.set('486:2', ['2026-10-05']);
    await w.run(); // the baseline
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    w.upstream.open.set('486:2', ['2026-10-05', '2026-10-06']);
    await w.run(); // the first email
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    w.upstream.open.set('486:2', ['2026-10-05', '2026-10-06', '2026-10-07']);
    await w.run(); // 7 Oct waits
    w.upstream.open.set('486', []); // then everything goes, even for one person
    for (let i = 0; i < 5; i++) await w.run();
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('ages each date on its own, so a new one never expires with an old one', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run();
    const open = (...dates: string[]) => w.upstream.open.set('486', ['2026-10-05', ...dates]);
    open();
    await w.run(); // email 1, at t0
    open('2026-10-06');
    await w.run(); // 6 Oct waits (t0 + 10 min)
    open();
    for (let i = 0; i < 14; i++) await w.run(); // 6 Oct closed; now t0 + 2 h 30
    open('2026-10-07');
    await w.run(); // email 2 with 7 Oct; 6 Oct, closed, keeps waiting
    expect(w.mailer.sent).toHaveLength(2);
    open('2026-10-07', '2026-10-08');
    await w.run(); // 8 Oct waits alongside the old 6 Oct (t0 + 2 h 50)
    for (let i = 0; i < 5; i++) await w.run(); // past 3 hours for 6 Oct, not for 8 Oct
    expect(w.mailer.sent).toHaveLength(3);
    expect(datesIn(w.mailer.sent[2]!.text)).toEqual(['Thu 8 Oct 2026']);
    expect(await w.kv.get(K.held(id))).toBeNull();
  });

  it('ignores a held alert signed for someone else', async () => {
    const w = await world();
    const ana = await w.subscribe('ana@example.com', [486], 1, 'hourly');
    const ben = await w.subscribe('ben@example.com', [486], 1, 'hourly');
    await w.run();
    const theirs = { id: 'x', createdAt: w.t.now(), subscriberId: ben, applicants: 1, openings: [{ id: 486, name: 'Antipolo', dates: ['2026-10-08'] }] };
    await w.kv.set(K.held(ana), sealJob(theirs, keys.token)); // moved by someone who can write to Redis
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    const toAna = w.mailer.sent.find((m) => m.to === 'ana@example.com')!;
    expect(datesIn(toAna.text)).toEqual(['Mon 5 Oct 2026']);
    expect(await w.kv.get(K.held(ana))).toBeNull(); // not kept, either
  });

  it('sends nothing to someone who unsubscribes while their alert is being prepared', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run();
    const incr = w.kv.incr.bind(w.kv);
    w.kv.incr = async (key, ttl, by) => {
      // The API unsubscribes them just as the checker counts this email against the day's total.
      if (key.startsWith('pp:mail:sent:')) await unsubscribe(w.kv, keys, signUnsubscribe(id, keys.token));
      return incr(key, ttl, by);
    };
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
    expect(await w.kv.get(K.held(id))).toBeNull();
    expect(Number(await w.kv.get(K.mailSentToday(manilaDay(w.t.now()))))).toBe(0);
  });

  it('keeps an hourly person to a full hour between emails', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486], 1, 'hourly');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email, at T
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // T + 10: 6 Oct waits
    w.t.advance(35 * 60_000); // T + 55 minutes
    await deliver(w.deps);
    expect(w.mailer.sent).toHaveLength(1);
    w.t.advance(5 * 60_000); // T + 60
    await deliver(w.deps);
    expect(w.mailer.sent).toHaveLength(2);
  });

  it('sends an asap person at most one email per check, even when the posts abroad come late in it', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486, 36], 1, 'asap');
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the baseline has 5 Oct open at 486
    const run = new Set<string>(); // one check: the Philippines, then the posts abroad
    const job = (siteId: number, date: string) => ({ id: `j${siteId}`, createdAt: w.t.now(), subscriberId: id, applicants: 1, openings: [{ id: siteId, name: `Office ${siteId}`, dates: [date] }] });
    await w.kv.write([{ op: 'rPush', key: K.outbox, values: [sealJob(job(486, '2026-10-05'), keys.token)] }]);
    await deliver(w.deps, w.t.now, run);
    w.t.advance(11 * 60_000); // the abroad pass may end 12 minutes into the check
    await w.kv.write([{ op: 'rPush', key: K.outbox, values: [sealJob(job(36, '2026-10-06'), keys.token)] }]);
    expect(await deliver(w.deps, w.t.now, run)).toMatchObject({ sent: 0, held: 1 });
    expect(w.mailer.sent).toHaveLength(1);
    await deliver(w.deps, w.t.now, new Set()); // the next check
    expect(w.mailer.sent).toHaveLength(2);
  });

  it('counts retries per date, so a new date is not lost with an old one that kept failing', async () => {
    const w = await world();
    const id = await w.subscribe('ana@example.com', [486], 1, 'hourly');
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run(); // the baseline: 6 Oct open
    const old = { id: 'old', createdAt: w.t.now(), subscriberId: id, applicants: 1, attempts: 2, openings: [{ id: 486, name: 'Antipolo', dates: ['2026-10-06'] }] };
    await w.kv.write([
      { op: 'set', key: K.held(id), value: sealJob(old, keys.token) },
      { op: 'sAdd', key: K.heldSubscribers, members: [id] },
    ]);
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    w.mailer.failNext = 1; // the merged email is refused, and tried again later in the same check
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    expect(datesIn(w.mailer.sent[0]!.text)).toEqual(['Mon 5 Oct 2026']); // 6 Oct had used its last try
    expect(await w.kv.get(K.held(id))).toBeNull();
  });

  it('refuses a backup whose pace is not one of the two', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [486], 1, 'asap');
    for (const pace of [123, null, 'daily']) {
      const backup = await exportSubscribers(w.kv, [486], 0);
      (backup.subscribers[0]!.fields as Record<string, unknown>).pace = pace;
      await expect(importSubscribers(new MemoryKv(), backup)).rejects.toThrow(/bad subscriber/);
    }
  });

  it('never emails an hourly person twice within 55 minutes, and only about dates open now', async () => {
    const SITE_IDS = [10, 20, 30, 486, 693];
    const step = fc.record({
      open: fc.array(fc.subarray(PUBLISHED), { minLength: 5, maxLength: 5 }),
      failing: fc.subarray(SITE_IDS, { maxLength: 1 }),
      minutes: fc.constantFrom(10, 15, 15, 30, 70),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 2, maxLength: 16 }), async (steps) => {
        const w = await world();
        const people = new Map<string, number>();
        for (const id of SITE_IDS) people.set(`p${id}@example.com`, id);
        for (const [email, id] of people) await w.subscribe(email, [id], 1, 'hourly');
        const lastMail = new Map<string, number>();
        const lastGood = new Map<number, Set<string>>();
        for (const s of steps) {
          SITE_IDS.forEach((id, i) => w.upstream.open.set(String(id), s.open[i]!));
          w.upstream.failing = new Set(s.failing);
          const before = w.mailer.sent.length;
          await runCheck({ ...w.deps, runId: `r${w.t.now()}` });
          // One failing office of five keeps the run healthy; the others were looked at.
          for (const id of SITE_IDS) if (!s.failing.includes(id)) lastGood.set(id, new Set(w.upstream.open.get(String(id))));
          for (const mail of w.mailer.sent.slice(before)) {
            const last = lastMail.get(mail.to);
            if (last !== undefined) expect(w.t.now() - last).toBeGreaterThanOrEqual(PACE_SPACING_MS.hourly);
            lastMail.set(mail.to, w.t.now());
            // "Open now" is as of the office's latest good look: that is all the checker can know.
            const open = lastGood.get(people.get(mail.to)!)!;
            for (const date of PUBLISHED) if (datesIn(mail.text).includes(formatDate(date))) expect(open.has(date)).toBe(true);
          }
          w.t.advance(s.minutes * 60_000);
        }
      }),
      { seed: 20260929, numRuns: RUNS },
    );
  }, 10_000 + RUNS * 10);
});

describe('clock steps', () => {
  const datesIn = (text: string) => [...text.matchAll(/ {2}- (\w{3} \d+ \w{3} \d{4})/g)].map((m) => m[1]);

  /** Real time moves on its own; the wall clock can be stepped away from it, and Redis expires keys by the wall clock. */
  async function stepped(opts: { noUptime?: boolean } = {}) {
    const t = clock();
    let step = 0;
    let boots = 1;
    let boot = 'boot-1';
    let bootAt = t.now() - 3600_000;
    let uptimeFails = false;
    const wall = () => t.now() + step;
    const kv = new MemoryKv(wall);
    const upstream = new FakeUpstream();
    const mailer = new FakeMailer();
    const { log } = recordingLog();
    const deps: CheckDeps = {
      kv, upstream, sink: new MemorySink(), mailer, keys, log,
      publicBaseUrl: 'https://penge.example', mailDailyLimit: 300, alertsPerSubscriberPerDay: 96,
      client: 'penge-passport-ph@test', now: wall, uptime: () => (opts.noUptime || uptimeFails ? null : { up: t.now() - bootAt, boot }),
    };
    const token = await createPending(kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'hourly' }, wall());
    await confirm(kv, token, wall());
    let n = 0;
    const run = async () => {
      await runCheck({ ...deps, runId: `run${++n}` });
      t.advance(10 * 60_000);
    };
    return {
      upstream, mailer, run, kv, wall, id: (await kv.sMembers(K.allSubscribers))[0]!,
      stepWall: (ms: number) => (step += ms),
      reboot: () => {
        boot = `boot-${++boots}`; // every boot has its own id
        bootAt = t.now();
      },
      /** The data moves to another machine, which has already been up for `upMs`; returns how to move it back. */
      moveTo: (upMs: number) => {
        const back = { boot, bootAt };
        boot = `machine-${++boots}`;
        bootAt = t.now() - upMs;
        return () => {
          boot = back.boot; // the old machine, still on the same boot
          bootAt = back.bootAt;
        };
      },
      uptimeFails: (fails: boolean) => (uptimeFails = fails),
      uptimeNow: () => ({ up: t.now() - bootAt, boot }),
    };
  }

  it('does not let a clock stepped forward send the next email early', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email, at T
    w.stepWall(2 * 3600_000); // NTP, or a VM snapshot, jumps the clock two hours ahead
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // T + 10 minutes of real time
    expect(w.mailer.sent).toHaveLength(1);
    for (let i = 0; i < 5; i++) await w.run(); // T + 60
    expect(w.mailer.sent).toHaveLength(2);
    expect(datesIn(w.mailer.sent[1]!.text)).toEqual(['Tue 6 Oct 2026']);
  });

  it('does not let a clock stepped back hold the next email up', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email, at T
    w.stepWall(-24 * 3600_000); // a day back
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run();
    expect(w.mailer.sent).toHaveLength(1); // not early, either
    for (let i = 0; i < 5; i++) await w.run(); // T + 60 of real time
    expect(w.mailer.sent).toHaveLength(2);
  });

  it('keeps a waiting date its 3 hours through a clock step', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // 6 Oct waits
    w.stepWall(4 * 3600_000); // past its 3 hours by the wall clock, and past the old Redis expiry
    for (let i = 0; i < 5; i++) await w.run();
    expect(w.mailer.sent).toHaveLength(2);
    expect(datesIn(w.mailer.sent[1]!.text)).toEqual(['Tue 6 Oct 2026']);
  });

  it('counts the gap from a reboot, whichever way the clock came back', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email, at T
    w.reboot();
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // T + 10 by the wall clock: too soon
    expect(w.mailer.sent).toHaveLength(1);
    w.reboot(); // again, and this time the clock comes back a day behind
    w.stepWall(-24 * 3600_000);
    await w.run(); // how long it has been is unknown: the hour starts again now, not early and not a day late
    expect(w.mailer.sent).toHaveLength(1);
    for (let i = 0; i < 5; i++) await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    await w.run(); // an hour after that check
    expect(w.mailer.sent).toHaveLength(2);
    expect(datesIn(w.mailer.sent[1]!.text)).toEqual(['Tue 6 Oct 2026']); // the waiting date survived it
  });

  it('gives a date whose age a reboot made unknowable 3 hours from then, no more', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // 6 Oct waits
    w.upstream.open.set('486', ['2026-10-05']); // and closes, for good
    w.reboot();
    w.stepWall(-24 * 3600_000);
    for (let i = 0; i < 19; i++) await w.run(); // checks from 0 to 3 hours after the reboot
    expect(await w.kv.get(K.held(w.id))).not.toBeNull();
    await w.run(); // 3 hours 10 minutes
    expect(await w.kv.get(K.held(w.id))).toBeNull();
  });

  it('does not announce a date again within 3 hours because the clock jumped', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // announced, at T
    w.upstream.open.set('486', []);
    await w.run(); // it closes
    w.stepWall(4 * 3600_000); // past its 3-hour mark by the wall clock (and Redis's expiry)
    w.upstream.open.set('486', ['2026-10-05']);
    for (let i = 0; i < 7; i++) await w.run(); // it opens again, an hour and more of real time later
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('never lets a clock that comes back ahead after a reboot bring the next email forward', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email, at T, in boot 1
    w.reboot();
    w.stepWall(2 * 3600_000); // the clock comes back two hours fast
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // T + 10 of real time, just after the reboot: held
    for (let i = 0; i < 5; i++) await w.run(); // up to an hour after the reboot
    expect(w.mailer.sent).toHaveLength(1);
    await w.run();
    expect(w.mailer.sent).toHaveLength(2);
  });

  it('counts a date\'s announcement window from a reboot, and announces it again once that has passed', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // announced, in boot 1
    w.reboot();
    w.upstream.open.set('486', []);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // opens again: its mark is from before the reboot, so it is as old as the reboot
    w.upstream.open.set('486', []);
    await w.run();
    for (let i = 0; i < 17; i++) await w.run(); // closed for 3 hours
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // opens again, more than 3 hours after the restart: news again
    expect(w.mailer.sent).toHaveLength(2);
  });

  it('without an uptime clock, restarts a date\'s announcement window that the clock puts in the future', async () => {
    const w = await stepped({ noUptime: true });
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // announced
    w.stepWall(-24 * 3600_000);
    w.upstream.open.set('486', []);
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // opens again: its mark is "in the future", so its 3 hours start now
    w.upstream.open.set('486', []);
    for (let i = 0; i < 19; i++) await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    for (let i = 0; i < 7; i++) await w.run(); // announced again, and the next hourly email goes
    expect(w.mailer.sent).toHaveLength(2);
  });

  it('restarts the gap after a move and after a move back, never counting time it cannot know', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email, at T, on the old machine
    const moveBack = w.moveTo(8 * 3600_000); // Valkey's data copied to a machine up for 8 hours
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // T + 10: held
    for (let i = 0; i < 5; i++) await w.run();
    expect(w.mailer.sent).toHaveLength(1); // an hour is counted from the first run there
    await w.run();
    expect(w.mailer.sent).toHaveLength(2); // sent on the new machine
    moveBack();
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    await w.run(); // back on the old machine, whose boot was seen long ago: its email's time is unknown here
    for (let i = 0; i < 5; i++) await w.run();
    expect(w.mailer.sent).toHaveLength(2);
    await w.run();
    expect(w.mailer.sent).toHaveLength(3);
  });

  it('keeps pace through a clock jump of days, which Redis would have expired keys over', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email
    w.stepWall(8 * 24 * 3600_000);
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('does not fall back to the wall clock when reading the uptime fails once', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email, stamped with uptime
    w.uptimeFails(true);
    w.stepWall(2 * 3600_000);
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('restarts a gap whose stamp is later than this boot\'s uptime (data from a restored snapshot)', async () => {
    const w = await stepped();
    await w.run();
    const { up, boot } = w.uptimeNow();
    await w.kv.set(K.lastAlert(w.id), JSON.stringify({ wall: w.wall(), up: up + 3600_000, boot }));
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // held, and the gap starts again now
    for (let i = 0; i < 5; i++) await w.run();
    expect(w.mailer.sent).toHaveLength(0);
    await w.run(); // an hour after, not two
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('treats a last-alert time from before uptimes as unknown, even from before this boot', async () => {
    const w = await stepped();
    await w.run();
    w.reboot(); // up for a minute or so when the old value is read
    await w.kv.set(K.lastAlert(w.id), String(w.wall() - 20 * 60_000)); // 20 minutes ago: before this boot
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // held: 20 minutes since the last email
    expect(parseStamp(await w.kv.get(K.lastAlert(w.id)))?.boot).toBe('boot-2');
    w.stepWall(3600_000);
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
  });

  it('gives a held alert written before uptimes its 3 hours from the upgrade, whatever the clock does', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email: the next is due in an hour
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    const legacy = { id: 'old', createdAt: w.wall(), subscriberId: w.id, applicants: 1, openings: [{ id: 486, name: 'Antipolo', dates: ['2026-10-06'] }] };
    await w.kv.write([
      { op: 'set', key: K.held(w.id), value: sealJob(legacy, keys.token) },
      { op: 'sAdd', key: K.heldSubscribers, members: [w.id] },
    ]);
    await w.run(); // read, and its 3 hours start now
    w.stepWall(4 * 3600_000);
    for (let i = 0; i < 5; i++) await w.run();
    expect(datesIn(w.mailer.sent[1]!.text)).toEqual(['Tue 6 Oct 2026']);
  });

  it('treats a last-alert time written before uptimes as unknown, so a clock step right after the upgrade does nothing', async () => {
    const w = await stepped();
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // the first email
    await w.kv.set(K.lastAlert(w.id), String(w.wall() - 10 * 60_000)); // as the previous release wrote it: 10 minutes ago
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06']);
    await w.run(); // held, and the gap starts again on this boot
    expect(parseStamp(await w.kv.get(K.lastAlert(w.id)))?.boot).toBe('boot-1');
    w.stepWall(2 * 3600_000);
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
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
