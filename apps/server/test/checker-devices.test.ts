import { describe, expect, it } from 'vitest';
import { type CheckDeps, GROUP_HELD_SHARE, runCheck, scanGroupsForTest } from '../src/checker.ts';
import type { SendResult, Transport } from '../src/devices/transport.ts';
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
    const w = await deviceWorld({ devices: { mode: 'live', transport: null } });
    await w.run(); // baseline
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) });
    w.upstream.open.set('486', ['2026-10-09']);
    w.upstream.open.set('693', ['2026-10-09']);
    await w.run();
    // The batch was written and, in the same run, turned into a job (Task 12 runs the second write); here: only 486.
    const queue = await w.kv.hGetAll(K.devQueue);
    const jobs = Object.values(queue).map((j) => JSON.parse(j) as { d: unknown[] });
    expect(jobs.flatMap((j) => j.d)).toEqual([[486, '2026-10-09', 1, 0]]);
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


class Pushes implements Transport {
  sent: Record<string, any>[] = [];
  next: SendResult[] = [];
  delayMs = 0;
  async send(_: unknown, payload: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.sent.push(JSON.parse(payload));
    return this.next.shift() ?? { kind: 'accepted' as const, status: 201 };
  }
}

describe('the notification pass', () => {
  it('sends a verified opening to a notification alert, with when it was checked', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) });
    w.upstream.open.set('486', ['2026-10-09']);
    const report = await w.run();
    expect(report.devices?.domestic).toMatchObject({ claimed: 1, accepted: 1 });
    expect(pushes.sent[0]).toMatchObject({ v: 1, title: 'Dates open at Antipolo', url: { office: 486, date: '2026-10-09', people: 1 } });
    expect(pushes.sent[0]!.body).toMatch(/· Checked \d\d:\d\d$/);
  });

  it('claims nothing once the batch\'s 60 seconds of sending are over, however long a read took', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) })).id);
    ids.sort();
    w.upstream.open.set('486', ['2026-10-09']);
    // Reading the second alert takes 61 seconds (a slow Valkey), after the first send started the batch's clock.
    const hGetAll = w.kv.hGetAll.bind(w.kv);
    w.kv.hGetAll = async (key: string) => {
      if (key === K.devAlert(ids[1]!) && pushes.sent.length === 1) w.t.advance(61_000);
      return hGetAll(key);
    };
    const report = await w.run();
    expect(report.devices?.domestic).toMatchObject({ claimed: 1, accepted: 1, stoppedBy: 'deadline' });
    // The abroad batch has its own 60 seconds: the second alert's work, left held, goes out there.
    expect(report.devices?.abroad).toMatchObject({ claimed: 1, accepted: 1 });
    expect(pushes.sent).toHaveLength(2);
    expect(await w.kv.hGetAll(K.devClaim(ids[1]!))).toEqual({});
  });

  it('keeps email and notifications independent: mail failing does not stop pushes, and the reverse', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    const token = await (await import('../src/subscribers.ts')).createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap' } as never, w.t.now());
    await (await import('../src/subscribers.ts')).confirm(w.kv, token, w.t.now());
    w.mailer.failNext = 3; // FakeMailer: the next sends fail as refused
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(pushes.sent).toHaveLength(1);
    pushes.next = [{ kind: 'refused', status: 503 }];
    w.upstream.open.set('486', ['2026-10-09', '2026-10-10']);
    w.mailer.failNext = 0;
    await w.run();
    expect(w.mailer.sent.some((m) => m.kind === 'alert')).toBe(true);
  });

  it('runs the abroad batch even when the abroad scan failed, sending what was verified at home', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes }, abroad: { sites: async () => { throw new Error('down'); }, availability: async () => { throw new Error('down'); } } as never });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    const report = await w.run();
    expect(report.devices?.abroad.stoppedBy).toBeNull();
    expect(pushes.sent).toHaveLength(1);
  });

  it('sends nothing in off mode; the work waits uncharged', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'off', transport: pushes } });
    await w.run();
    const a = await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(pushes.sent).toEqual([]);
    expect(await w.kv.get(K.devToday(a.id, (await import('../src/keys.ts')).manilaDay(w.t.now())))).toBeNull();
  });

  it('stops claiming at a batch\'s 60 seconds of sending; the abroad batch, with its own 60 s, sends the rest', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    for (let i = 0; i < 12; i++) await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    pushes.send = async (_: unknown, payload: string) => {
      w.t.advance(7_000); // each send takes 7 s of the batch's 60
      pushes.sent.push(JSON.parse(payload));
      return { kind: 'accepted', status: 201 };
    };
    const report = await w.run();
    // 7 s a send: the domestic batch sends 9 (63 s > 60 s stops it before a tenth), and the abroad batch, which sends
    // what was verified at home too, has its own 60 s for the 3 left.
    expect(report.devices?.domestic).toMatchObject({ stoppedBy: 'deadline', accepted: 9 });
    expect(report.devices?.abroad).toMatchObject({ accepted: 3 });
    expect(pushes.sent).toHaveLength(12);
  });

  it('sends nothing more after a rejection, even to the alert that was waiting for the rejected send\'s slot', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    for (let i = 0; i < 12; i++) await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    let n = 0;
    pushes.send = async (_: unknown, payload: string) => {
      const mine = ++n;
      pushes.sent.push(JSON.parse(payload));
      // The first send is rejected after the other seven slots are taken; the ninth alert waits for its slot.
      await new Promise((r) => setTimeout(r, mine === 1 ? 30 : 60));
      return mine === 1 ? { kind: 'rejected', status: 401 } : { kind: 'accepted', status: 201 };
    };
    const report = await w.run();
    expect(report.devices?.domestic.stoppedBy).toBe('rejected');
    expect(pushes.sent).toHaveLength(8);
  });

  it('finishes the sends it started before a lost lock ends the batch', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    for (let i = 0; i < 3; i++) await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    let finished = 0;
    pushes.send = async (_: unknown, payload: string) => {
      // The first send outlives the lock: another run takes it while this send is on the wire.
      if (pushes.sent.length === 0) await w.kv.set(K.checkLock, 'another-run');
      pushes.sent.push(JSON.parse(payload));
      await new Promise((r) => setTimeout(r, 20));
      finished++;
      return { kind: 'accepted', status: 201 };
    };
    await w.run().catch(() => undefined);
    expect(finished).toBe(pushes.sent.length); // nothing still on the wire when the run returns
    expect(pushes.sent.length).toBeLessThan(3);
  });

    it('sends one notification per alert per run, however many batches', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(pushes.sent).toHaveLength(1);
  });
});

describe('clean-up in a run', () => {
  it('runs before the cooldown, so a resting run still cleans up', async () => {
    const w = await deviceWorld({ devices: { mode: 'live', transport: null } });
    const a = await seedAlert(w.kv, { now: w.t.now() - 1000, end: w.t.now() - 1 });
    await w.kv.set(K.scanCooldown, 'x', { ttlSeconds: 600 });
    expect((await w.run()).skipped).toBe('cooling down');
    expect(await w.kv.hGetAll(K.devAlert(a.id))).toEqual({});
  });

  it('skips only the notification pass when clean-up fails; scans and email go on', async () => {
    const w = await deviceWorld({ devices: { mode: 'live', transport: null } });
    await w.kv.set(K.devGarbage, 'not a hash');
    const report = await w.run();
    expect(report.healthy).toBe(true);
    expect(report.devices).toBeNull();
    expect(w.lines.some((l) => l.includes('notification clean-up failed'))).toBe(true);
  });
});
