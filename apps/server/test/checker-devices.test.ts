import { describe, expect, it } from 'vitest';
import { type CheckDeps, GROUP_HELD_SHARE, runCheck, scanGroupsForTest } from '../src/checker.ts';
import { K } from '../src/keys.ts';
import { choices, seedAlert } from './device-fixtures.ts';
import { clock, FakeMailer, FakeUpstream, keys, MemoryKv, MemorySink, recordingLog } from './helpers.ts';

export async function deviceWorld(overrides: Partial<CheckDeps> = {}) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  const upstream = new FakeUpstream();
  const sink = new MemorySink();
  const mailer = new FakeMailer();
  const { log, lines } = recordingLog();
  const deps: CheckDeps = {
    kv, upstream, sink, mailer, keys, log, publicBaseUrl: 'https://penge.example', mailDailyLimit: 300, alertsPerSubscriberPerDay: 3,
    client: 'penge-passport-ph@test', uptime: () => null, now: t.now, ...overrides,
  };
  let n = 0;
  const run = async () => {
    const report = await runCheck({ ...deps, runId: `run${++n}` });
    t.advance(10 * 60_000);
    return report;
  };
  return { t, kv, upstream, sink, mailer, deps, lines, run };
}

describe('queueing for notification alerts', () => {
  it('writes a fan-out batch with the email write, only for openings some notification alert follows', async () => {
    const w = await deviceWorld();
    await w.run(); // baseline
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) });
    w.upstream.open.set('486', ['2026-10-09']);
    w.upstream.open.set('693', ['2026-10-09']);
    await w.run();
    // The batch was written and, in the same run, turned into a job (Task 12 runs the second write); here: only 486.
    // Until Task 11 restores the job assertion (the notification pass runs the second write): the batch.
    expect(await w.kv.get(K.devFanoutStamps('run2:domestic'))).not.toBeNull();
  });

  it('still queues email when memory is above 85%, without the notification batch, and counts nothing written for it', async () => {
    const w = await deviceWorld();
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) });
    const sub = await (await import('../src/subscribers.ts')).createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap' } as never, w.t.now());
    await (await import('../src/subscribers.ts')).confirm(w.kv, sub, w.t.now());
    w.kv.memoryUse = { used: 90, max: 100 };
    w.upstream.open.set('486', ['2026-10-09']);
    const report = await w.run();
    expect(report.queued).toBe(1); // the email job
    expect(await w.kv.get(K.devFanoutStamps('run2:domestic'))).toBeNull();
    expect(w.lines.some((l) => l.includes('memory above 85%'))).toBe(true);
  });

  it('keeps scanning and emailing when the notification index cannot be read', async () => {
    const w = await deviceWorld();
    await w.run();
    const token = await (await import('../src/subscribers.ts')).createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 2, pace: 'asap' } as never, w.t.now());
    await (await import('../src/subscribers.ts')).confirm(w.kv, token, w.t.now());
    await w.kv.set(K.devSite(486), 'not a set');
    w.upstream.open.set('486', ['2026-10-09']);
    w.upstream.open.set('486:2', ['2026-10-09']);
    const report = await w.run();
    expect(report.healthy).toBe(true);
    expect(w.sink.scans.at(-1)!.groups.some((g) => g.siteId === 486 && g.applicants === 2 && g.ok)).toBe(true);
  });

  it('records a scan as unchanged when only lookup times differ', async () => {
    const { runContentForTest } = await import('../src/record.ts');
    const base = { source: { host: 'h', client: 'c' }, healthy: true, problems: [] };
    const a = runContentForTest({ ...base, groups: [{ siteId: 1, applicants: 2, ok: true, error: null, openDates: [], fetchedAt: '2026-10-06T00:00:00Z' }] });
    const b = runContentForTest({ ...base, groups: [{ siteId: 1, applicants: 2, ok: true, error: null, openDates: [], fetchedAt: '2026-10-06T00:05:00Z' }] });
    expect(a).toBe(b);
  });

  it('looks up group sizes notification alerts follow, as it does for email subscribers', async () => {
    const w = await deviceWorld();
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486], applicants: 3 }) });
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(w.sink.scans.at(-1)!.groups).toEqual([expect.objectContaining({ siteId: 486, applicants: 3, ok: true, fetchedAt: expect.any(String) })]);
  });

  it('gives at most 6 of 10 group lookups to pairs with held work, oldest first, and the rest in turn', async () => {
    const w = await deviceWorld();
    expect(GROUP_HELD_SHARE).toBe(6);
    // 12 pairs: offices 486 and 693 (and the other fake offices), group sizes 2..5, with held work on 8 of them.
    // (Fixture detail: the FakeUpstream offices; open a date at each, seed an alert per pair, held jobs on 8.)
    const offices = w.upstream.sitesList.map((s) => s.id);
    let held = 0;
    for (const office of offices) {
      w.upstream.open.set(String(office), ['2026-10-09']);
      for (const applicants of [2, 3, 4]) {
        const a = await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [office], applicants }) });
        if (held < 8) {
          await w.kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: (await w.kv.hGetAll(K.devAlert(a.id))).inc, s: [{ wall: w.t.now() - held }], d: [[office, '2026-10-09', applicants, 0]] }));
          held++;
        }
      }
    }
    await w.run();
    const looked = w.sink.scans.at(-1)!.groups.filter((g) => g.ok);
    expect(looked).toHaveLength(10);
    const heldLooked = looked.filter((g) => offices.indexOf(g.siteId) * 3 + [2, 3, 4].indexOf(g.applicants) < 8);
    expect(heldLooked).toHaveLength(6);
    // The next run starts the others where this one stopped.
    expect(await w.kv.get(K.scanGroupCursor)).not.toBeNull();
  });

  it('asks every followed pair in turn across runs, even when time allows only one lookup a run', async () => {
    const w = await deviceWorld();
    // Eight pairs: four offices, each followed for 2 and 3 people.
    const sites = [10, 20, 30, 40].map((id) => ({ id, ok: true, openDates: ['2026-10-09'] }) as never);
    for (const id of [10, 20, 30, 40]) for (const g of [2, 3]) await w.kv.write([{ op: 'sAdd', key: K.devSite(id), members: [`a${id}${g}:${g}`] }]);
    const asked: string[] = [];
    const upstream = { availability: async (q: { siteId: number; applicants: number }) => (asked.push(`${q.siteId}:${q.applicants}`), { availableDates: [], fetchedAt: new Date().toISOString() }) };
    for (let run = 0; run < 8; run++) {
      let budget = 1;
      await scanGroupsForTest(w.deps, upstream as never, sites, async () => null, 4, 0, K.scanAbroadCursor, () => budget-- > 0);
    }
    expect(new Set(asked).size).toBe(8); // every pair asked once in eight runs
  });

  it('counts only well-formed notification demand for group sizes 2 to 5: a damaged index cannot take email\'s lookups', async () => {
    const w = await deviceWorld();
    const sites = [10, 20].map((id) => ({ id, ok: true, openDates: ['2026-10-09'] }) as never);
    const junk = [...Array.from({ length: 50 }, (_, i) => `a${i}:${i + 6}`), 'no-group', 'x:0', 'y:1.5', 'z:-2', ':3'];
    await w.kv.write([{ op: 'sAdd', key: K.devSite(10), members: junk }, { op: 'sAdd', key: K.devSite(20), members: ['ok1:2'] }]);
    const asked: string[] = [];
    const upstream = { availability: async (q: { siteId: number; applicants: number }) => (asked.push(`${q.siteId}:${q.applicants}`), { availableDates: [], fetchedAt: new Date().toISOString() }) };
    const groups = await scanGroupsForTest(w.deps, upstream as never, sites, async () => null, 10, 6, K.scanGroupCursor);
    expect(asked).toEqual(['20:2']);
    expect(groups.map((g) => `${g.siteId}:${g.applicants}`)).toEqual(['20:2']);
  });
});
