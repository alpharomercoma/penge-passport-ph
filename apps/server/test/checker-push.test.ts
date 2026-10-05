import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pace } from '@penge/contracts';
import { ACTIVE_EVERY_MINUTES } from '../src/abroad.ts';
import { addDelivery, type CheckDeps, type DeliveryReport, runCheck, sealJob, settleOutcome, shouldRunAbroadDelivery } from '../src/checker.ts';
import { K, manilaDay } from '../src/keys.ts';
import { MemoryKv } from '../src/kv.ts';
import { listDevices } from '../src/push/devices.ts';
import { deviceCall } from '../src/push/register.ts';
import type { PushTransport } from '../src/push/sender.ts';
import { confirm, createPending } from '../src/subscribers.ts';
import { clock, FakeMailer, FakeUpstream, fcmSubscription, keys, MemorySink, recordingLog } from './helpers.ts';

class FakePush implements PushTransport {
  sent: { endpoint: string; payload: string }[] = [];
  attempts = 0;
  answer: (endpoint: string) => Promise<void> = async () => {};
  async send(sub: { endpoint: string }, payload: string) {
    this.attempts++;
    await this.answer(sub.endpoint);
    this.sent.push({ endpoint: sub.endpoint, payload });
  }
}

async function world(over: Partial<CheckDeps> = {}, start?: number) {
  const t = clock(start);
  const kv = new MemoryKv(t.now);
  const upstream = new FakeUpstream();
  const mailer = (over.mailer as FakeMailer | undefined) ?? new FakeMailer();
  const push = new FakePush();
  const { log, lines } = recordingLog();
  const deps: CheckDeps = {
    kv, upstream, sink: new MemorySink(), mailer, keys, log,
    publicBaseUrl: 'https://penge.example', mailDailyLimit: 300, alertsPerSubscriberPerDay: 288,
    client: 'penge-passport-ph@test', uptime: () => null, now: t.now,
    push: { mode: 'live', transport: push },
    ...over,
  };
  let n = 0;
  const run = async () => {
    const report = await runCheck({ ...deps, runId: `run${++n}` });
    t.advance(10 * 60_000);
    return report;
  };
  const subscribeWith = async (email: string, siteIds: number[], ch: { emailOn: boolean; pushOn: boolean }, pace: Pace = 'asap') => {
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(kv, keys, {
      email, siteIds, applicants: 1, pace,
      channels: { ...ch, pushCredentialHash: ch.pushOn ? hash : null, device: ch.pushOn ? 'Chrome on Android' : null },
    }, t.now());
    const r = await confirm(kv, keys, token, t.now(), ch);
    if (r.status !== 'confirmed' && r.status !== 'updated') throw new Error(`confirm: ${r.status}`);
    if (ch.pushOn) {
      const s = fcmSubscription();
      const state = await deviceCall(kv, keys, { credential, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 1, now: t.now() });
      if (state !== 'registered') throw new Error(`register: ${state}`);
    }
    return r.subscriberId;
  };
  return { t, kv, upstream, mailer, push, deps, lines, run, subscribeWith };
}

const alerts = (m: FakeMailer) => m.sent.filter((x) => x.kind === 'alert');
type World = Awaited<ReturnType<typeof world>>;
/** A baseline run, then a run where Antipolo opens a date. */
async function opens(w: World, dates = ['2026-10-06']) {
  await w.run();
  w.upstream.open.set('486', dates);
  return w.run();
}

describe('delivering to every channel', () => {
  it('sends push to a push-only person and no email', async () => {
    const w = await world();
    const id = await w.subscribeWith('ana@example.com', [486], { emailOn: false, pushOn: true });
    await opens(w);
    expect(w.push.sent).toHaveLength(1);
    expect(JSON.parse(w.push.sent[0]!.payload).title).toBe('Dates open at Antipolo');
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(await w.kv.get(K.mailSentToday(manilaDay(w.t.now())))).toBeNull();
    expect(await w.kv.get(K.lastAlert(id))).not.toBeNull();
  });

  it('sends both to a person with both on, and charges email once', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await opens(w);
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(1);
    expect(await w.kv.get(K.mailSentToday(manilaDay(w.t.now())))).toBe('1');
  });

  it('removes an awaiting device older than 48 hours before anyone is considered', async () => {
    const w = await world();
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: false });
    const id = (await w.kv.sMembers(K.allSubscribers))[0]!;
    const t2 = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    await confirm(w.kv, keys, t2, w.t.now(), { emailOn: true, pushOn: true });
    expect(Object.keys(await w.kv.hGetAll(K.pushMeta(id)))).toHaveLength(1);
    w.t.advance(49 * 3600_000);
    await w.run();
    expect(await w.kv.hGetAll(K.pushMeta(id))).toEqual({});
  });

  it('holds a push-only person whose device is still awaiting registration, uncharged', async () => {
    const w = await world();
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    const r = await confirm(w.kv, keys, token, w.t.now(), { emailOn: false, pushOn: true });
    const id = r.status === 'confirmed' ? r.subscriberId : '';
    const report = await opens(w);
    expect(w.push.attempts).toBe(0);
    expect(await w.kv.get(K.lastAlert(id))).toBeNull();
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([id]);
    expect(report.delivery!.push.heldNoChannel).toBe(1);
  });

  it('keeps pushing when the email limit is reached, and holds email-only people', async () => {
    const w = await world({ mailDailyLimit: 0 });
    const emailOnly = await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: false });
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    const report = await opens(w);
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([emailOnly]);
    expect(report.delivery!.emailBlocked).toBe('daily limit');
    expect(report.delivery!.stoppedBy).toBeNull();
  });

  it('keeps pushing while mail is paused', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.upstream.open.set('486', ['2026-10-06']);
    const report = await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(report.delivery!.emailBlocked).toBe('paused');
  });

  it('keeps pushing after three mail errors in a row', async () => {
    const w = await world();
    for (const name of ['a', 'b', 'c', 'd']) await w.subscribeWith(`${name}@example.com`, [486], { emailOn: true, pushOn: true });
    await w.run();
    w.mailer.failNext = 3;
    w.upstream.open.set('486', ['2026-10-06']);
    const report = await w.run();
    expect(w.push.sent).toHaveLength(4);
    expect(report.delivery!.emailBlocked).toBe('mail errors');
  });

  it('pushes for a post abroad while email is blocked, in the abroad delivery pass', async () => {
    const { abroadWorld } = await import('./abroad-world.ts');
    const push = new FakePush();
    const w = await abroadWorld({ mailDailyLimit: 0, push: { mode: 'live', transport: push } });
    await w.subscribeWith('ana@example.com', [497], { emailOn: true, pushOn: true });
    await w.run(); // the first look at the post is a baseline
    w.abroad.open.set('497', ['2026-10-06']);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    const report = await w.run();
    expect(report.abroad).toMatchObject({ trusted: true, queued: 1 });
    expect(push.sent).toHaveLength(1);
    expect(JSON.parse(push.sent[0]!.payload).title).toBe('Dates open at Copenhagen');
    expect(w.mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(0);
  });

  it('gives each delivery its own notification tag, even when a held job goes out in two parts', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: false, pushOn: true }, 'hourly');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // delivered now; the next waits an hour (hourly pace)
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    await w.run(); // 6 and 7 are news: held, as one job
    for (let i = 0; i < 6; i++) {
      w.upstream.open.set('486', ['2026-10-05', '2026-10-06']); // 7 is closed when the hour is up
      await w.run();
    }
    expect(w.push.sent).toHaveLength(2); // 5, then 6; 7 still waits with the same job
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    for (let i = 0; i < 7; i++) await w.run();
    expect(w.push.sent).toHaveLength(3); // then 7, from the job's leftover
    const tags = w.push.sent.map((p) => JSON.parse(p.payload).tag as string);
    expect(new Set(tags).size).toBe(3);
  });

  it('runs the abroad delivery pass unless every channel was unavailable', () => {
    const base = { sent: 0, dryRun: 0, skipped: 0, failed: 0, dropped: 0, held: 0, remaining: 0, emailBlocked: 'daily limit', push: { accepted: 0, refused: 0, uncertain: 0, gone: 0, heldNoChannel: 0 } } as const;
    expect(shouldRunAbroadDelivery({ ...base, stoppedBy: null } as DeliveryReport)).toBe(true);
    expect(shouldRunAbroadDelivery({ ...base, stoppedBy: 'all channels' } as DeliveryReport)).toBe(false);
  });

  it('settles every outcome as the spec table says', () => {
    expect(settleOutcome('sent', 'none', true)).toBe('delivered');
    expect(settleOutcome('refused', 'accepted', true)).toBe('delivered');
    expect(settleOutcome('refused', 'uncertain', true)).toBe('delivered');
    expect(settleOutcome('refused', 'none', true)).toBe('retry');
    expect(settleOutcome('uncertain', 'none', true)).toBe('delivered');
    expect(settleOutcome('none', 'accepted', true)).toBe('delivered');
    expect(settleOutcome('none', 'none', true)).toBe('retry');
    expect(settleOutcome('dry-run', 'none', false)).toBe('delivered');
    expect(settleOutcome('dry-run', 'none', true)).toBe('retry');
  });

  it('refunds the email allowance when email is refused but push got through, and does not retry', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    w.mailer.failNext = 1;
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(await w.kv.get(K.mailSentToday(manilaDay(w.t.now())))).toBe('0');
    await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(0);
  });

  it('undoes everything and retries when email is refused and every push is refused', async () => {
    const w = await world();
    const id = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    w.mailer.failNext = 1;
    w.push.answer = async () => { throw Object.assign(new Error('x'), { statusCode: 503 }); };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(await w.kv.get(K.lastAlert(id))).toBeNull();
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([id]);
    w.push.answer = async () => {};
    await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(1);
  });

  it('treats a timed-out push as delivered and never sends it again', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: false, pushOn: true });
    w.push.answer = async () => { throw new Error('Socket timeout'); };
    await opens(w);
    await w.run();
    expect(w.push.attempts).toBe(1);
  });

  it('counts a simulated email only for people without push', async () => {
    const w = await world({ mailer: new FakeMailer('dry-run') });
    w.push.answer = async () => { throw Object.assign(new Error('x'), { statusCode: 503 }); };
    const both = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    const emailOnly = await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: false });
    await opens(w);
    expect(await w.kv.get(K.lastAlert(emailOnly))).not.toBeNull();
    expect(await w.kv.get(K.lastAlert(both))).toBeNull();
  });

  it('keeps the alert of a push-on person when push is paused and email is only simulated', async () => {
    const w = await world({ mailer: new FakeMailer('dry-run') });
    const id = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    await w.kv.set(K.pushPaused, '1');
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(await w.kv.get(K.lastAlert(id))).toBeNull();
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([id]);
  });

  it('gives a new Manila day a fresh email allowance in a run that crosses midnight', async () => {
    // 23:40 in Manila on 27 September; the baseline run moves the clock to 23:50.
    const w = await world({ mailDailyLimit: 1 }, Date.parse('2026-09-27T15:40:00Z'));
    await w.subscribeWith('a@example.com', [486], { emailOn: true, pushOn: false });
    await w.subscribeWith('b@example.com', [486], { emailOn: true, pushOn: true });
    await w.subscribeWith('c@example.com', [486], { emailOn: true, pushOn: false });
    await w.run();
    // b's push takes 15 minutes: c is considered on the 28th.
    w.push.answer = async () => { w.t.advance(15 * 60_000); };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(alerts(w.mailer)).toHaveLength(2); // a on the 27th, c on the 28th; b's email was blocked by the 27th's limit
    expect(w.push.sent).toHaveLength(1);
    expect(await w.kv.get(K.mailSentToday('2026-09-28'))).toBe('1');
  });

  it('stops starting pushes after the budget and lets email carry on', async () => {
    const w = await world();
    for (const name of ['a', 'b', 'c']) await w.subscribeWith(`${name}@example.com`, [486], { emailOn: true, pushOn: true });
    await w.run();
    w.push.answer = async () => { w.t.advance(30_000); };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(w.push.sent).toHaveLength(2);
    expect(alerts(w.mailer)).toHaveLength(3);
  });

  it('checks the lock once a pass has run for 30 seconds, and stops if it was lost', async () => {
    let checks = 0;
    const w = await world({ lockCheck: async () => { checks++; throw new Error('lost the checker lock; stopping this run'); } });
    for (const name of ['a', 'b', 'c']) await w.subscribeWith(`${name}@example.com`, [486], { emailOn: false, pushOn: true });
    await w.run();
    w.push.answer = async () => { w.t.advance(20_000); };
    w.upstream.open.set('486', ['2026-10-06']);
    await expect(w.run()).rejects.toThrow(/lost the checker lock/);
    expect(checks).toBe(1);
    expect(w.push.sent).toHaveLength(2);
  });

  it('sends no email to someone who turned email off while their alert was being prepared', async () => {
    const w = await world();
    const id = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    const incr = w.kv.incr.bind(w.kv);
    w.kv.incr = async (key, ttl, by) => {
      const n = await incr(key, ttl, by);
      // A confirmation for "notifications only" commits just as the alert is charged.
      if (key.startsWith('pp:alerts:')) await w.kv.write([{ op: 'hSet', key: K.subscriber(id), fields: { emailOn: '0' } }]);
      return n;
    };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(w.push.sent).toHaveLength(1);
    expect(await w.kv.get(K.mailSentToday(manilaDay(w.t.now())))).toBe('0');
  });

  it('keeps delivering when one awaiting device cannot be read', async () => {
    const w = await world();
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    await confirm(w.kv, keys, token, w.t.now(), { emailOn: true, pushOn: true });
    const ana = (await w.kv.sMembers(K.allSubscribers))[0]!;
    const [dev] = await listDevices(w.kv, ana);
    await w.kv.write([{ op: 'hSet', key: K.pushDevices(ana), fields: { [dev!.id]: 'v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }]);
    await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: false });
    w.t.advance(49 * 3600_000);
    await opens(w);
    expect(alerts(w.mailer)).toHaveLength(2);
    expect(await listDevices(w.kv, ana)).toHaveLength(1); // kept: never removed for a record it could not read
  });

  it('tries one person once per check, however many jobs they have', async () => {
    const w = await world();
    const id = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: false });
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    const job = (n: number) => sealJob({ id: `j${n}`, createdAt: w.t.now(), subscriberId: id, applicants: 1, openings: [{ id: 486, name: 'Antipolo', dates: ['2026-10-06'] }] }, keys.token);
    await w.kv.write([{ op: 'rPush', key: K.outbox, values: [job(1), job(2)] }]);
    w.mailer.failNext = 1;
    const report = await w.run();
    expect(report.delivery).toMatchObject({ failed: 1, sent: 0 });
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([id]);
  });

  it('starts the push budget after the clean-up of old devices', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: false, pushOn: true });
    await w.run();
    const hGetAll = w.kv.hGetAll.bind(w.kv);
    let slow = true;
    w.kv.hGetAll = async (key) => {
      if (slow && key.startsWith('pp:push:meta:')) {
        slow = false;
        w.t.advance(61_000); // a long clean-up
      }
      return hGetAll(key);
    };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(w.push.sent).toHaveLength(1);
  });

  it('reports why email could not go out when no channel could', async () => {
    const w = await world({ mailer: new FakeMailer('off') });
    const report = await w.run();
    expect(report.delivery).toMatchObject({ stoppedBy: null, emailBlocked: 'off' });
    const noPush = await world({ mailer: new FakeMailer('off'), push: { mode: 'off', transport: null } });
    expect((await noPush.run()).delivery).toMatchObject({ stoppedBy: 'all channels', emailBlocked: 'off' });
  });

  it('checks the lock after a long clean-up, before anything is sent', async () => {
    let checks = 0;
    const w = await world({ lockCheck: async () => { checks++; throw new Error('lost the checker lock; stopping this run'); } });
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: false });
    await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    const hGetAll = w.kv.hGetAll.bind(w.kv);
    let reads = 0;
    w.kv.hGetAll = async (key) => {
      const v = await hGetAll(key);
      if (key.startsWith('pp:push:meta:') && ++reads === 2) w.t.advance(61_000); // the clean-up's last read stalls
      return v;
    };
    w.upstream.open.set('486', ['2026-10-06']);
    await expect(w.run()).rejects.toThrow(/lost the checker lock/);
    expect(checks).toBeGreaterThan(0);
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(w.push.sent).toHaveLength(0);
  });

  it('keeps email stopped for the pass after three failures, even when a pause comes and goes', async () => {
    const w = await world();
    for (const name of ['a', 'b', 'c', 'd', 'e']) await w.subscribeWith(`${name}@example.com`, [486], { emailOn: true, pushOn: false });
    await w.run();
    w.mailer.failNext = 3;
    const get = w.kv.get.bind(w.kv);
    let pausedOnce = false;
    w.kv.get = async (key) => {
      if (key === K.mailPaused && w.mailer.failNext === 0 && !pausedOnce) {
        pausedOnce = true;
        return '1'; // paused for a moment, then lifted
      }
      return get(key);
    };
    w.upstream.open.set('486', ['2026-10-06']);
    const report = await w.run();
    expect(report.delivery).toMatchObject({ failed: 3, sent: 0 });
    expect(alerts(w.mailer)).toHaveLength(0);
  });

  it('reports the email block as the last pass of the check found it', () => {
    const base = { sent: 0, dryRun: 0, skipped: 0, failed: 0, dropped: 0, held: 0, remaining: 0, push: { accepted: 0, refused: 0, uncertain: 0, gone: 0, heldNoChannel: 0 } };
    const first: DeliveryReport = { ...base, stoppedBy: null, emailBlocked: 'daily limit' };
    const second: DeliveryReport = { ...base, stoppedBy: null, emailBlocked: null };
    expect(addDelivery(first, second).emailBlocked).toBeNull();
  });

  it('never lets a push that fails to start lose an alert or stop the others', async () => {
    const w = await world();
    const ana = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: false });
    await w.run();
    const hGetAll = w.kv.hGetAll.bind(w.kv);
    w.kv.hGetAll = async (key) => {
      if (key === K.pushDevices(ana)) throw new Error('store unreachable');
      return hGetAll(key);
    };
    w.upstream.open.set('486', ['2026-10-06']);
    const report = await w.run();
    expect(alerts(w.mailer)).toHaveLength(2); // ana's email and ben's both went
    expect(report.delivery!.sent).toBe(2);
  });

  it('skips the clean-up of a busy address and still delivers to everyone', async () => {
    const w = await world();
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    await confirm(w.kv, keys, token, w.t.now(), { emailOn: true, pushOn: true }); // a device that never registered
    await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: false });
    await w.run();
    for (const id of await w.kv.sMembers(K.allSubscribers)) {
      const h = await w.kv.hGetAll(K.subscriber(id));
      if (Object.keys(await w.kv.hGetAll(K.pushMeta(id))).length > 0) await w.kv.set(K.addressLock(h.index!), 'a crashed request', { ttlSeconds: 3600 });
    }
    w.upstream.open.set('486', ['2026-10-06']);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const running = w.run();
    await vi.advanceTimersByTimeAsync(30_000);
    await running;
    vi.useRealTimers();
    expect(alerts(w.mailer).length).toBeGreaterThanOrEqual(1); // ben's at least; nothing stopped the check
    expect(w.lines.some((l) => l.includes('awaiting devices not cleaned up'))).toBe(true);
  });
});
