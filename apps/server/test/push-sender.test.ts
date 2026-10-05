import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { K } from '../src/keys.ts';
import { MemoryKv } from '../src/kv.ts';
import { silentLog } from '../src/log.ts';
import { listDevices, openDevice, sealDevice } from '../src/push/devices.ts';
import { buildPayload } from '../src/push/payload.ts';
import { deviceCall } from '../src/push/register.ts';
import { PushPool, type PushTransport, pushDecision } from '../src/push/sender.ts';
import { confirm, createPending, load } from '../src/subscribers.ts';
import { clock, fcmSubscription, keys } from './helpers.ts';

describe('push payload', () => {
  it('names one office, or counts them, and the group size', () => {
    const one = JSON.parse(buildPayload({ openings: [{ id: 486, name: 'Antipolo (SM Center, Antipolo City, Rizal)', dates: ['2026-10-09', '2026-10-12'] }], applicants: 2, decisionId: 'd1' }));
    expect(one).toMatchObject({ v: 1, title: 'Dates open at Antipolo', tag: 'alert-d1', url: { office: 486, date: '2026-10-09', people: 2 } });
    expect(one.body).toBe('Fri 9 Oct and Mon 12 Oct · for 2 people');
  });

  it('stays under 3 KB for ten offices with many dates (Review Focus 4)', () => {
    const dates = Array.from({ length: 40 }, (_, i) => `2026-11-${String((i % 28) + 1).padStart(2, '0')}`);
    const openings = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, name: `Office ${i} (A very long mall name, ${'x'.repeat(80)})`, dates }));
    const p = buildPayload({ openings, applicants: 1, decisionId: 'd2' });
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(3000);
    expect(JSON.parse(p).title).toBe('Dates open at 10 offices');
    expect(JSON.parse(p).body).toMatch(/and \d+ more · for 1 person$/);
  });

  it('stays under 3 KB whatever the office is called', () => {
    const p = buildPayload({ openings: [{ id: 1, name: '界'.repeat(1500), dates: ['2026-11-02'] }], applicants: 1, decisionId: 'd3' });
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(3000);
    expect(JSON.parse(p).title).toMatch(/^Dates open at 界+/);
  });

  it('stays under 3 KB for any input at all, falling back to a plain notification', () => {
    for (const p of [
      buildPayload({ openings: [{ id: 486, name: 'Antipolo', dates: ['2026-11-02'] }], applicants: 1, decisionId: 'x'.repeat(4000) }),
      buildPayload({ openings: [{ id: 486, name: 'Antipolo', dates: ['界'.repeat(1500)] }], applicants: 1, decisionId: 'd4' }),
    ]) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(3000);
      expect(JSON.parse(p)).toMatchObject({ v: 1, title: expect.stringMatching(/^Dates open/) });
    }
  });
});

const sub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } };

describe('push pool', () => {
  it('keeps at most 8 sends in flight', async () => {
    let inFlight = 0;
    let most = 0;
    const transport: PushTransport = {
      async send() {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: clock().now });
    await Promise.all(Array.from({ length: 30 }, (_, i) => pool.send(`d${i}`, 'e', sub, '{}')));
    expect(most).toBe(8);
  });

  it('stops offering slots once the budget is spent, and still settles started sends', async () => {
    const t = clock();
    const transport: PushTransport = { async send() { t.advance(30_000); } };
    const pool = new PushPool({ transport, inFlight: 1, budgetMs: 60_000, timeoutMs: 5000, now: t.now });
    expect(pool.reserve()).toBe(true);
    await pool.send('d1', 'e', sub, '{}');
    expect(pool.reserve()).toBe(true);
    await pool.send('d2', 'e', sub, '{}');
    expect(pool.hasBudget()).toBe(false);
    expect(pool.reserve()).toBe(false);
    await pool.settle();
  });

  it('gives up on a transport that never answers, frees its slot, and calls it uncertain', async () => {
    vi.useFakeTimers();
    const transport: PushTransport = { send: () => new Promise(() => {}) };
    const pool = new PushPool({ transport, inFlight: 1, budgetMs: 60_000, timeoutMs: 5000, now: Date.now });
    const first = pool.send('d1', 'e1', sub, '{}');
    const second = pool.send('d2', 'e2', sub, '{}'); // waits for the only slot
    await vi.advanceTimersByTimeAsync(6000);
    expect((await first).result).toBe('uncertain');
    await vi.advanceTimersByTimeAsync(6000);
    expect((await second).result).toBe('uncertain');
    await pool.settle();
    vi.useRealTimers();
  });

  it('never runs more than its bound, whenever new sends arrive', async () => {
    const ticks = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    let inFlight = 0;
    let most = 0;
    const transport: PushTransport = {
      async send() {
        inFlight++;
        most = Math.max(most, inFlight);
        await ticks(rand(6));
        inFlight--;
      },
    };
    const pool = new PushPool({ transport, inFlight: 2, budgetMs: 60_000, timeoutMs: 5000, now: clock().now });
    await Promise.all(Array.from({ length: 300 }, async (_, i) => { await ticks(rand(40)); return pool.send(`d${i}`, 'e', sub, '{}'); }));
    expect(most).toBe(2);
  });

  it('classifies a transport that throws at once, and frees its slot', async () => {
    const transport: PushTransport = { send: () => { throw Object.assign(new Error('x'), { statusCode: 400 }); } };
    const pool = new PushPool({ transport, inFlight: 1, budgetMs: 60_000, timeoutMs: 5000, now: clock().now });
    expect((await pool.send('d1', 'e', sub, '{}')).result).toBe('refused');
    expect((await pool.send('d2', 'e', sub, '{}')).result).toBe('refused');
    await pool.settle();
  });

  it('turns a timeout into uncertain and a 410 into gone', async () => {
    const transport: PushTransport = {
      async send(s) {
        if (s.endpoint.endsWith('gone')) throw Object.assign(new Error('x'), { statusCode: 410 });
        throw new Error('Socket timeout');
      },
    };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: clock().now });
    expect((await pool.send('d1', 'e1', { ...sub, endpoint: 'https://fcm.googleapis.com/gone' }, '{}')).result).toBe('gone');
    expect((await pool.send('d2', 'e2', sub, '{}')).result).toBe('uncertain');
  });
});

/** A subscriber with `n` registered devices on fcm.googleapis.com. */
async function withDevices(n: number) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  const creds: string[] = [];
  let id = '';
  for (let i = 0; i < n; i++) {
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(kv, keys, { email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, t.now());
    const r = await confirm(kv, keys, token, t.now(), { emailOn: true, pushOn: true });
    if (r.status !== 'confirmed' && r.status !== 'updated') throw new Error(r.status);
    id = r.subscriberId;
    const s = fcmSubscription(`dev${i}`);
    expect(await deviceCall(kv, keys, { credential, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 1, now: t.now() })).toBe('registered');
    creds.push(credential);
  }
  const index = (await load(kv, id))!.index;
  return { t, kv, id, index, creds };
}

describe('pushing one decision', () => {
  it('removes a gone device and keeps the other', async () => {
    const w = await withDevices(2);
    const transport: PushTransport = { async send(s) { if (s.endpoint.endsWith('dev0')) throw Object.assign(new Error('x'), { statusCode: 410 }); } };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    const r = await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' });
    expect(r.any).toBe('accepted');
    const [kept] = await listDevices(w.kv, w.id);
    expect(kept).toBeTruthy();
    expect(openDevice(keys, (await w.kv.hGetAll(K.pushDevices(w.id)))[kept!.id]!).lastSuccessAt).toBeTruthy();
  });

  it('never removes a device when a rotation races a push', async () => {
    for (let i = 0; i < 20; i++) {
      const w = await withDevices(1);
      const transport: PushTransport = { async send() { throw Object.assign(new Error('x'), { statusCode: 410 }); } };
      const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
      const s = fcmSubscription(`rot${i}`);
      await Promise.all([
        pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' }),
        deviceCall(w.kv, keys, { credential: w.creds[0]!, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 2, now: w.t.now() }),
      ]);
      // Either the 410 was for the old endpoint and the device kept its new one, or the rotation came after the removal and says missing.
      const left = await listDevices(w.kv, w.id);
      if (left.length === 1) expect(left[0]!.meta.revision).toBe(2);
    }
  });

  it('keeps a device whose endpoint changed while the 410 was on its way', async () => {
    const w = await withDevices(1);
    const transport: PushTransport = {
      async send() {
        const s = fcmSubscription('rotated');
        await deviceCall(w.kv, keys, { credential: w.creds[0]!, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 2, now: w.t.now() });
        throw Object.assign(new Error('x'), { statusCode: 410 });
      },
    };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' });
    expect(await listDevices(w.kv, w.id)).toHaveLength(1);
  });

  it('never sends to a stored endpoint that fails the checks, and removes it', async () => {
    const w = await withDevices(1);
    const [dev] = await listDevices(w.kv, w.id);
    await w.kv.write([{ op: 'hSet', key: K.pushDevices(w.id), fields: { [dev!.id]: sealDevice(keys, { endpoint: 'https://127.0.0.1/x', p256dh: fcmSubscription().keys.p256dh, auth: fcmSubscription().keys.auth, label: null, createdAt: new Date(w.t.now()).toISOString() }) } }]);
    let sent = 0;
    const pool = new PushPool({ transport: { async send() { sent++; } }, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    const r = await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' });
    expect(sent).toBe(0);
    expect(r.any).toBe('none');
    expect(await listDevices(w.kv, w.id)).toHaveLength(0);
  });

  it('skips a device whose record cannot be opened, keeps it, and still sends to the others', async () => {
    const w = await withDevices(2);
    const [first] = await listDevices(w.kv, w.id);
    await w.kv.write([{ op: 'hSet', key: K.pushDevices(w.id), fields: { [first!.id]: 'v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }]);
    let sent = 0;
    const pool = new PushPool({ transport: { async send() { sent++; } }, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    const r = await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' });
    expect(sent).toBe(1);
    expect(r.any).toBe('accepted');
    expect(await listDevices(w.kv, w.id)).toHaveLength(2); // never removed for a record it could not read
  });

  it('sends only to the named device when asked', async () => {
    const w = await withDevices(2);
    const seen: string[] = [];
    const pool = new PushPool({ transport: { async send(s) { seen.push(s.endpoint); } }, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    const [, second] = await listDevices(w.kv, w.id);
    await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}', onlyDeviceId: second!.id });
    expect(seen).toHaveLength(1);
  });
});
