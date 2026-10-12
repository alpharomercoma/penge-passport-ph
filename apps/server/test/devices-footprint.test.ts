// Measured on a real Valkey: the largest valid records, and the whole namespace filled to its ceilings (used_memory
// before and after, so the allocator and the tables count). Runs only with DEVICE_TEST_VALKEY.
import { createClient } from '@redis/client';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { DEVICE_COUNTERS } from '../src/devices/counters.ts';
import { DEVICE_LIMITS, rateKeys } from '../src/devices/limits.ts';
import { CHUNK_WORK } from '../src/devices/queue.ts';
import { fanoutChunk, queueWrite } from '../src/devices/scripts-delivery.ts';
import { ALERT_UNITS, OP_UNITS, sealSetup, sealSubscription, UNIT_BYTES } from '../src/devices/store.ts';
import { K } from '../src/keys.ts';
import { checkPushSubscription } from '../src/push/endpoint.ts';
import { choices, seedAlert } from './device-fixtures.ts';
import { fcmSubscription, keys } from './helpers.ts';
import { valkeyTargets } from './valkey.ts';

const valkey = valkeyTargets().find(([name]) => name === 'Valkey');
const T0 = Date.parse('2026-10-06T02:00:00Z');
const BUDGET = 0.25 * 64 * 1024 * 1024;
type Kv = Awaited<ReturnType<NonNullable<typeof valkey>[1]>>;
const usage = (kv: Kv, key: string) =>
  kv.script({ name: 'usage', lua: "#!lua\nreturn tostring(redis.call('MEMORY', 'USAGE', KEYS[1], 'SAMPLES', '0') or 0)" }, [key], []).then(Number);
const b64 = () => Buffer.alloc(32, 1).toString('base64');
// The configuration's ceilings (DEVICE_ALERT_LIMIT and DEVICE_RECORD_LIMIT cannot be set higher).
const ceilings = () => loadConfig({ REDIS_URL: 'redis://localhost:6379', EMAIL_ENC_KEY: b64(), EMAIL_HMAC_KEY: b64(), TOKEN_SECRET: b64() }).devices;

/** The largest subscription the server accepts (its stored endpoint 1,024 characters, nothing JSON escapes), one per n. */
function largestSubscription(n = 0) {
  const head = 'https://wns2-db5p.notify.windows.com/w/?token=';
  const s = checkPushSubscription({ endpoint: `${head}${String(n).padStart(1024 - head.length, 'A')}`, keys: fcmSubscription().keys });
  if (!s) throw new Error('fixture subscription refused');
  return s;
}
/** The largest choices: ten offices with the longest ids the office lists use, five people. */
const LARGEST = choices({ siteIds: Array.from({ length: 10 }, (_, i) => 1_000_000_000 + i), applicants: 5, pace: 'hourly' });
const id22 = (n: number) => n.toString(36).padStart(22, '0');
const id43 = (n: number) => n.toString(36).padStart(43, '0');

/** Writes many short keys at once, through a script (each with an expiry, as the limiter's are). */
async function counters(kv: Kv, names: string[]) {
  for (let i = 0; i < names.length; i += 4000) {
    await kv.script(
      { name: 'fill-counters', lua: "#!lua\nfor i = 1, #KEYS do redis.call('SET', KEYS[i], '240', 'PX', 7200000) end return 'ok'" },
      names.slice(i, i + 4000),
      [],
    );
  }
}

/** One alert at its largest: record, indexes, delivery state, end record, and its operation: an unfinished captured
 * setup holding its sealed request (the largest an alert's one operation unit can hold). */
async function largestAlert(kv: Kv, n: number, sub: ReturnType<typeof largestSubscription>, picked = LARGEST) {
  const a = await seedAlert(kv, { id: id22(n), cred: id43(n), now: T0, choices: picked, sub, order: n });
  const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
  const stamps = Array.from({ length: 30 }, (_, i) => ({ wall: T0 + i, up: 123456789.123 + i, boot: '0f8fad5b-d9cb-469f-a165-70867728950e' }));
  const job = JSON.stringify({ i: a.id, n: inc, s: stamps, d: stamps.map((_, i) => [picked.siteIds[i % 10], `2026-11-${String(i + 1).padStart(2, '0')}`, 5, i]) });
  if (job.length > 4096) throw new Error('job over 4 KB');
  const today = ['2026-10-05', '2026-10-06'];
  await kv.write([
    { op: 'hSet', key: K.devQueue, fields: { [a.id]: job } },
    { op: 'set', key: K.devHeld(a.id), value: job },
    { op: 'hSet', key: K.devClaim(a.id), fields: { cid: 'c'.repeat(22), run: 'r'.repeat(20), inc, gen: '999', rev: '999', day: today[1]!, prev: JSON.stringify(stamps[0]), at: JSON.stringify(stamps[1]), state: 'sending', job, checked: String(T0) } },
    { op: 'set', key: K.devLast(a.id), value: JSON.stringify(stamps[0]) },
    ...today.map((d) => ({ op: 'set' as const, key: K.devToday(a.id, d), value: '288', ttlSeconds: 172800 })),
    { op: 'hSet', key: K.devTried(a.id), fields: Object.fromEntries([['run', 'r'.repeat(20)], ...stamps.map((_, i) => [`${picked.siteIds[i % 10]}|2026-11-${String(i + 1).padStart(2, '0')}|5`, '2'])]) },
    { op: 'hSet', key: K.devEnded(a.hash), fields: { reason: 'gone', at: String(T0), fp: 'f'.repeat(43) } },
    // Its operation: a captured setup in progress, with the largest sealed request and its nonce hash.
    { op: 'hSet', key: K.devOp(a.hash), fields: { op: 'o'.repeat(22), seq: '9007199254740991', maxseq: '9007199254740991', kind: 'setup', digest: 'd'.repeat(43), cap: JSON.stringify({ incarnation: 'i'.repeat(22), generation: 999, revision: 999 }), alert: a.id, rsv: '', other: '', exp: String(T0), dsp: 'retryable', did: 'x'.repeat(22), dspAt: String(T0), retry: String(T0), why: 'backoff', result: '', act: '', done: '', sealed: sealSetup(keys, { subscription: sub, choices: LARGEST, nonce: 'n'.repeat(43) }), nh: 'n'.repeat(43), ep: 'e'.repeat(43), fp: 'f'.repeat(43), svc: 'wns', tok: 't'.repeat(43), acks: '10', started: String(T0) } },
  ]);
  await kv.script(
    { name: 'fill-indexes', lua: "#!lua\nredis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) redis.call('ZADD', KEYS[2], ARGV[1], ARGV[3]) redis.call('ZADD', KEYS[3], ARGV[1], ARGV[4]) return 'ok'" },
    [K.devQueued, K.devOps, K.devDeadlines],
    [String(T0), a.id, a.hash, `ended|${a.hash}`],
  );
  return a;
}

/** One unit's largest record: an unfinished setup of another credential, with its sealed request. */
async function largestOperation(kv: Kv, n: number, sub: ReturnType<typeof largestSubscription>) {
  const cred = id43(1_000_000 + n);
  const sealed = sealSetup(keys, { subscription: sub, choices: LARGEST, nonce: 'n'.repeat(43) });
  await kv.write([
    { op: 'hSet', key: K.devOp(cred), fields: { op: 'o'.repeat(22), seq: '9007199254740991', maxseq: '9007199254740991', kind: 'rotate', digest: 'd'.repeat(43), cap: JSON.stringify({ incarnation: 'i'.repeat(22), generation: 999, revision: 999 }), alert: 'a'.repeat(22), rsv: 'repl', other: 'b'.repeat(22), exp: String(T0), dsp: 'retryable', did: 'x'.repeat(22), dspAt: String(T0), retry: String(T0), why: 'backoff', result: '', act: '', done: '', sealed, nh: 'n'.repeat(43), ep: 'e'.repeat(43), fp: 'f'.repeat(43), svc: 'wns', tok: 't'.repeat(43), acks: '10', started: String(T0) } },
  ]);
  await kv.script({ name: 'fill-op', lua: "#!lua\nredis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) return 'ok'" }, [K.devOps], [String(T0), cred]);
  return { cred, sealed };
}

describe.skipIf(!valkey)('the largest footprint, measured', () => {
  it('fits an alert with its largest delivery state and end record in ALERT_UNITS units', async () => {
    const kv = await valkey![1]();
    const a = await largestAlert(kv, 1, largestSubscription());
    let bytes = 0;
    for (const key of [K.devAlert(a.id), K.devHeld(a.id), K.devClaim(a.id), K.devLast(a.id), K.devToday(a.id, '2026-10-05'), K.devToday(a.id, '2026-10-06'), K.devTried(a.id), K.devEnded(a.hash), K.devCred(a.hash), K.devEndpoint(a.ep), K.devQueue]) bytes += await usage(kv, key);
    console.log(JSON.stringify({ alertBytes: bytes, unit: UNIT_BYTES, units: ALERT_UNITS }));
    expect(bytes).toBeLessThanOrEqual(ALERT_UNITS * UNIT_BYTES);
  });

  it('fits an operation record, sealed with the largest accepted request, in one unit', async () => {
    const kv = await valkey![1]();
    const { cred, sealed } = await largestOperation(kv, 1, largestSubscription());
    const bytes = await usage(kv, K.devOp(cred));
    console.log(JSON.stringify({ opBytes: bytes, sealedChars: sealed.length }));
    expect(bytes).toBeLessThanOrEqual(OP_UNITS * UNIT_BYTES);
  });

  // Every alert on the same ten offices (ten large index sets), or each on ten of its own (thousands of small ones).
  it.each(['concentrated', 'dispersed'] as const)("holds the whole namespace at its ceilings, the limiter's worst case and 40 days of numbers within 25% of 64 MB (offices %s)", async (layout) => {
    const kv = await valkey![1]();
    const admin = createClient({ url: process.env.DEVICE_TEST_VALKEY! });
    await admin.connect();
    const used = async () => Number(/used_memory:(\d+)/.exec(await admin.info('memory'))![1]);
    try {
      const c = ceilings();
      const before = await used();
      // Alerts at their largest, each on its own subscription with an operation in progress; the remaining units as the
      // largest one-unit record.
      const picked = (n: number) => (layout === 'concentrated' ? LARGEST : { ...LARGEST, siteIds: Array.from({ length: 10 }, (_, i) => 1_000_000_000 + n * 10 + i) });
      for (let n = 0; n < c.alertLimit; n++) await largestAlert(kv, n, largestSubscription(n), picked(n));
      const rest = c.recordLimit - c.alertLimit * (ALERT_UNITS + OP_UNITS);
      for (let n = 0; n < rest; n++) await largestOperation(kv, n, largestSubscription(c.alertLimit + n));
      const endpoints = await kv.script({ name: 'count-endpoints', lua: "#!lua\nreturn tostring(#redis.call('KEYS', ARGV[1]))" }, [], [`${K.devEndpoint('')}*`]);
      expect(Number(endpoints)).toBe(c.alertLimit);
      await kv.write([
        { op: 'hSet', key: K.devRecords, fields: { units: String(c.recordLimit), alerts: String(c.alertLimit), repl: '30' } },
        { op: 'set', key: K.devOrder, value: '9007199254740991' },
        { op: 'set', key: K.devCursor('domestic'), value: id22(1) },
        { op: 'set', key: K.devCursor('abroad'), value: id22(1) },
        { op: 'hSet', key: K.persist, fields: { aofRewrites: '999999', aofIdleAt: String(T0), aofOkAfter: String(T0), aofOkBy: String(T0) } },
        ...['fcm', 'mozilla', 'wns', 'apple'].map((s) => ({ op: 'set' as const, key: K.pushBackoff(s), value: String(T0) })),
      ]);
      // Five pending fan-out batches at their largest: 2,000 entries of 64 bytes, and 4 KB of stamps.
      for (let b = 0; b < 5; b++) {
        await kv.write([
          { op: 'rPush', key: K.devFanout(`r${b}:domestic`), values: Array.from({ length: 2000 }, (_, i) => `${1_000_000_000 + (i % 10)}|2026-11-${String((i % 28) + 1).padStart(2, '0')}|5|${String(i).padStart(30, '0')}`.slice(0, 64)) },
          { op: 'set', key: K.devFanoutStamps(`r${b}:domestic`), value: JSON.stringify({ order: 9007199254740991, stamps: [{ wall: T0, up: 1, boot: 'x'.repeat(4000) }] }) },
          { op: 'rPush', key: K.devFanouts, values: [`r${b}:domestic`] },
        ]);
      }
      // Every rate counter the gates can make, two windows each.
      const names: string[] = [];
      const credentials = c.alertLimit + c.recordLimit;
      for (const [name, l] of Object.entries(DEVICE_LIMITS)) {
        const ids: string[] =
          name === 'ingress'
            ? Array.from({ length: 4096 }, (_, i) => String(i))
            : name.endsWith('Ip')
              ? Array.from({ length: 4096 }, (_, i) => `b${i}`)
              : name.endsWith('Cred')
                ? Array.from({ length: credentials }, (_, i) => id43(i))
                : name === 'setupPushEndpoint'
                  ? Array.from({ length: DEVICE_LIMITS.storedSetupAll.max + DEVICE_LIMITS.maintenanceAll.max }, (_, i) => id43(i))
                  : name === 'maintenanceAlert' || name === 'testAlert'
                    ? Array.from({ length: c.alertLimit }, (_, i) => id22(i))
                    : ['all'];
        for (const id of ids) {
          const k = rateKeys(l, id, T0);
          names.push(k.cur, k.prev);
        }
      }
      await counters(kv, names);
      // Forty days of numbers: every listed counter with large values; the pools' refusals under every pool's real name,
      // and every other family with more and longer names than the code makes (25 of 24 characters).
      const fields: Record<string, string> = { since: String(T0), recounted: '1' };
      for (const { name } of DEVICE_COUNTERS) {
        if (name === 'requests_refused_*') for (const l of Object.values(DEVICE_LIMITS)) fields[`requests_refused_${l.bucket}`] = '9999999';
        else if (name.endsWith('*')) for (let i = 0; i < 25; i++) fields[`${name.slice(0, -1)}${String(i).padStart(24, 'x')}`] = '9999999';
        else fields[name] = '9999999';
      }
      for (let d = 0; d < 40; d++) await kv.write([{ op: 'hSet', key: K.statsV2(`2026-09-${String((d % 30) + 1).padStart(2, '0')}x${d}`), fields }]);
      const total = (await used()) - before;
      console.log(JSON.stringify({ layout, alertLimit: c.alertLimit, recordLimit: c.recordLimit, counters: names.length, total, budget: BUDGET }));
      expect(total).toBeLessThanOrEqual(BUDGET);
    } finally {
      await admin.close();
    }
  }, 120_000);

  it('at its memory limit: refuses scripts that grow storage before they start, writing nothing; reclamation still runs', async () => {
    const kv = await valkey![1]();
    const admin = createClient({ url: process.env.DEVICE_TEST_VALKEY! });
    await admin.connect();
    try {
      const a = await seedAlert(kv, { now: T0, end: T0 - 1 });
      const used = Number(/used_memory:(\d+)/.exec(await admin.info('memory'))![1]);
      await admin.configSet('maxmemory', String(used - 1024));
      const { admit, reclaim, turnOff } = await import('../src/devices/scripts-api.ts');
      const before = await kv.hGetAll(K.devRecords);
      await expect(admit(kv, { now: T0, cred: 'h'.repeat(43), op: 'o'.repeat(22), seq: 1, kind: 'setup', cap: false, digest: 'd', ep: 'e', fp: 'f', svc: 'fcm', sealed: 'v2.x', nh: 'n', tok: '', exp: T0 + 1, stored: [], alertLimit: 10, recordLimit: 100 })).rejects.toThrow(/OOM/);
      expect(await kv.hGetAll(K.devRecords)).toEqual(before);
      expect((await reclaim(kv, T0)).ended).toBe(1); // allow-oom: runs over the limit, and frees the alert
      await turnOff(kv, { now: T0, cred: a.hash });
    } finally {
      await admin.configSet('maxmemory', '64mb');
      await admin.close();
    }
  });

  it('writes a fan-out chunk at the alert ceiling in under 50 ms, merging into the largest jobs and skipping other groups', async () => {
    const kv = await valkey![1]();
    await kv.set(K.checkLock, 'r1');
    const c = ceilings();
    const stamps = Array.from({ length: 30 }, (_, i) => ({ wall: T0 + i, up: 123456789.123 + i, boot: '0f8fad5b-d9cb-469f-a165-70867728950e' }));
    // The ceiling's alerts on one office: every one holding a full job (30 dates, 30 stamps) to merge into and bound;
    // and as many again for another group size, which the chunk reads and skips.
    for (let n = 0; n < 2 * c.alertLimit; n++) {
      const group = n < c.alertLimit ? 1 : 5;
      const a = await seedAlert(kv, { id: id22(n), now: T0, order: 0, choices: choices({ siteIds: [486], applicants: group }) });
      const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
      const job = JSON.stringify({ i: a.id, n: inc, s: stamps, d: stamps.map((_, i) => [486, `2026-12-${String(i + 1).padStart(2, '0')}`, group, i]) });
      await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [a.id]: job } }]);
    }
    await queueWrite(kv, { now: T0, run: 'r1', mark: 'measure', ops: [], batch: { id: 'b1', entries: Array.from({ length: 100 }, (_, i) => `486|2026-11-${String((i % 28) + 1).padStart(2, '0')}|1|0`), stamps: [{ wall: T0 }] } });
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const r = await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: CHUNK_WORK });
      worst = Math.max(worst, performance.now() - started);
      if (r.done) break;
    }
    console.log(JSON.stringify({ chunkMs: worst, work: CHUNK_WORK }));
    expect(worst).toBeLessThan(50);
  }, 120_000);
});
