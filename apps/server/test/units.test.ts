import { mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import {
  decryptEmail,
  emailIndex,
  encryptEmail,
  randomToken,
  signUnsubscribe,
  verifyUnsubscribe,
} from '../src/crypto.ts';
import { hit } from '../src/limits.ts';
import { line, silentLog } from '../src/log.ts';
import { wasRefused } from '../src/mailer.ts';
import { r2Sink, readSpool } from '../src/r2.ts';
import { recordKey } from '../src/record.ts';
import { assessHealth, newlyOpened, parseDates, type Scan } from '../src/snapshot.ts';
import { alertEmail, confirmationEmail, formatDate, shortName } from '../src/templates.ts';
import { keys, MemoryKv } from './helpers.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 500);
const opts = { seed: 20260927, numRuns: RUNS };

describe('crypto', () => {
  it('round-trips, and refuses anything tampered with', () => {
    const sealed = encryptEmail('a@b.co', keys.email);
    expect(sealed).not.toContain('a@b.co');
    expect(encryptEmail('a@b.co', keys.email)).not.toBe(sealed); // a fresh IV each time
    expect(decryptEmail(sealed, keys.email)).toBe('a@b.co');
    const [v, body] = sealed.split('.');
    const flipped = Buffer.from(body!, 'base64url');
    flipped[14]! ^= 1;
    expect(() => decryptEmail(`${v}.${flipped.toString('base64url')}`, keys.email)).toThrow();
    expect(() => decryptEmail(sealed, Buffer.alloc(32))).toThrow();
    expect(() => decryptEmail('v2.abc', keys.email)).toThrow();
  });

  it('indexes the same address the same way, and different ones differently', () => {
    expect(emailIndex('a@b.co', keys.index)).toBe(emailIndex('a@b.co', keys.index));
    expect(emailIndex('a@b.co', keys.index)).not.toBe(emailIndex('a@b.cO', keys.index));
    expect(emailIndex('a@b.co', keys.index)).not.toBe(emailIndex('a@b.co', keys.email));
  });

  it('accepts only unsubscribe links it signed', () => {
    const token = signUnsubscribe('abcdefghijklmnopqrstuv', keys.token);
    expect(verifyUnsubscribe(token, keys.token)).toBe('abcdefghijklmnopqrstuv');
    expect(verifyUnsubscribe(token, keys.email)).toBeNull();
    expect(verifyUnsubscribe(`x${token}`, keys.token)).toBeNull();
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), fc.string({ unit: 'binary', maxLength: 80 }), (a, b) => {
        expect(verifyUnsubscribe(`${a}.${b}`, keys.token)).toBeNull();
        expect(verifyUnsubscribe(a, keys.token)).toBeNull();
      }),
      opts,
    );
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 200 }), (id, at) => {
        const good = signUnsubscribe(id, keys.token);
        expect(verifyUnsubscribe(good, keys.token)).toBe(id.includes('.') ? null : id);
        const i = at % good.length;
        const bad = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
        expect(verifyUnsubscribe(bad, keys.token)).not.toBe(id.includes('.') ? 'never' : id);
      }),
      opts,
    );
  });

  it('makes 43-character url-safe tokens', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('templates', () => {
  it('formats dates the same way everywhere', () => {
    expect(formatDate('2026-10-05')).toBe('Mon 5 Oct 2026');
    expect(formatDate('2027-01-31')).toBe('Sun 31 Jan 2027');
    expect(formatDate('garbage')).toBe('garbage');
  });

  it('shortens site names for subjects', () => {
    expect(shortName('Antipolo (SM Center, Antipolo City, Rizal)')).toBe('Antipolo');
    expect(shortName('DFA NCR Central - (Robinsons Galleria Ortigas, Quezon City)')).toBe('DFA NCR Central');
    expect(shortName('Paniqui,  Tarlac (WalterMart)')).toBe('Paniqui,  Tarlac');
    expect(shortName('(odd)')).toBe('(odd)');
  });

  it('escapes whatever the passport site calls a place', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 20 }), (name, extra) => {
        const hostile = `<script>${name}</script>"'&${extra}`;
        const alert = alertEmail({
          openings: [{ id: 1, name: hostile, dates: ['2026-10-05'] }],
          applicants: 1,
          unsubscribeUrl: 'https://x.example/unsubscribe#token=a',
          manageUrl: 'https://x.example/',
          lastToday: false,
        });
        const confirm = confirmationEmail({ confirmUrl: 'https://x.example/confirm#token=a', sites: [{ id: 1, name: hostile }], applicants: 1, pace: 'hourly' });
        for (const html of [alert.html, confirm.html]) {
          expect(html).not.toContain('<script>');
          expect(html).not.toContain(`"'&${extra}`);
        }
        expect(alert.subject).not.toMatch(/[\r\n]/);
      }),
      opts,
    );
  });

  it('shows each recorded check in Manila time across midnight, with no fabricated fallback', () => {
    const mail = alertEmail({
      openings: [
        { id: 1, name: 'A', dates: ['2026-10-05'], checkedAt: '2026-09-30T16:01:02Z' },
        { id: 2, name: 'B', dates: ['2026-10-05'], checkedAt: '2026-09-30T15:59:00Z' },
        { id: 3, name: 'C', dates: ['2026-10-05'], checkedAt: 'invalid' },
        { id: 4, name: 'D', dates: ['2026-10-05'] },
      ],
      applicants: 2, unsubscribeUrl: 'https://x.example/unsubscribe#token=a', manageUrl: 'm', lastToday: false,
    });
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('Oct 1, 2026, 12:01:02 AM (Manila time, UTC+8)');
      expect(part).toContain('Sep 30, 2026, 11:59:00 PM (Manila time, UTC+8)');
      expect(part.match(/Office calendar check time unavailable/g)).toHaveLength(2);
      expect(part).toContain('Already booked a slot? Unsubscribe');
    }
    expect(mail.html).toContain('href="https://x.example/unsubscribe#token=a"');
    expect(mail.html).not.toContain('/api/unsubscribe');
  });

  it('lists at most three places in a subject', () => {
    const openings = ['A (x)', 'B (x)', 'C (x)', 'D (x)', 'E (x)'].map((name, id) => ({ id, name, dates: ['2026-10-05'] }));
    const { subject } = alertEmail({ openings, applicants: 1, unsubscribeUrl: 'u', manageUrl: 'm', lastToday: false });
    expect(subject).toBe('Passport dates open: A, B, C +2');
  });
});

describe('scan rules', () => {
  const site = (ok: boolean, publishedDays = 3) => ({
    id: 1, name: 'x', address: null, telephone: null, mapUrl: null, ok, error: null, from: null, to: null, publishedDays, openDates: [], days: [], fetchedAt: null,
  });

  it('draws the health line at 20% failed sites', () => {
    expect(assessHealth(true, [site(false), ...Array(4).fill(site(true))]).healthy).toBe(true);
    expect(assessHealth(true, [site(false), site(false), ...Array(3).fill(site(true))]).healthy).toBe(false);
    expect(assessHealth(true, [site(true, 0), site(true, 0)]).problems).toEqual(['no site publishes any dates']);
    expect(assessHealth(false, []).healthy).toBe(false);
  });

  it('finds new dates only against a baseline', () => {
    expect(newlyOpened(undefined, ['2026-10-05'])).toBeNull();
    expect(newlyOpened(['2026-10-05'], ['2026-10-06', '2026-10-05'])).toEqual(['2026-10-06']);
    expect(newlyOpened([], [])).toEqual([]);
  });

  it('treats a damaged baseline as none', () => {
    expect(parseDates('["2026-10-05"]')).toEqual(['2026-10-05']);
    expect(parseDates('["2026-02-31"]')).toBeUndefined(); // not a day: no baseline, never a false "new" date
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const parsed = parseDates(raw);
        if (parsed) for (const d of parsed) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }),
      opts,
    );
    expect(parseDates('{"a":1}')).toBeUndefined();
    expect(parseDates('["x"]')).toBeUndefined();
  });
});

describe('config', () => {
  const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64');
  const env = {
    REDIS_URL: 'redis://localhost:6379',
    R2_ENDPOINT: 'https://r2.example',
    R2_BUCKET: 'b',
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
    EMAIL_ENC_KEY: b64(32),
    EMAIL_HMAC_KEY: b64(32),
    TOKEN_SECRET: b64(32),
  };

  it('defaults to dry-run and safe limits', () => {
    const config = loadConfig(env);
    expect(config.mailMode).toBe('dry-run');
    expect(config.mailDailyLimit).toBe(300);
    // A safety net above what either pace allows: 24 an hour apart, 288 one per check.
    expect(config.alertsPerSubscriberPerDay).toBe(288);
    expect(config.statsEmail).toBeNull();
    expect(config.api).toEqual({ host: '127.0.0.1', port: 8787 });
  });

  it.each([
    [{ REDIS_URL: '' }, /REDIS_URL/],
    [{ EMAIL_ENC_KEY: b64(16) }, /32 bytes/],
    [{ MAIL_MODE: 'yes' }, /MAIL_MODE/],
    [{ MAIL_MODE: 'live' }, /MAIL_FROM and PUBLIC_BASE_URL/],
    [{ PUBLIC_BASE_URL: 'http://penge.example' }, /https/],
    [{ SMTP_PORT: '0' }, /SMTP_PORT/],
    [{ MAIL_DAILY_LIMIT: '1.5' }, /MAIL_DAILY_LIMIT/],
  ])('refuses %j', (patch, error) => {
    expect(() => loadConfig({ ...env, ...patch })).toThrow(error);
    expect(() => loadConfig({ ...env, ...patch })).toThrow(ConfigError);
  });

  it('allows live mail once the domain is set', () => {
    const config = loadConfig({ ...env, MAIL_MODE: 'live', MAIL_FROM: 'alerts@penge.example', PUBLIC_BASE_URL: 'https://penge.example/' });
    expect(config.publicBaseUrl).toBe('https://penge.example');
  });

  it('lets the API run without R2 credentials, but never half of them or without TLS', () => {
    const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, ...apiOnly } = env;
    expect(loadConfig(apiOnly).r2).toBeNull();
    expect(() => loadConfig({ ...apiOnly, R2_BUCKET: 'b' })).toThrow(/or none/);
    expect(() => loadConfig({ ...env, R2_ENDPOINT: 'http://r2.example' })).toThrow(/https/);
  });

  it('refuses plaintext Redis anywhere but this server', () => {
    const remote = { ...env, REDIS_URL: 'redis://default:pw@redis-1.example.com:6379' };
    expect(() => loadConfig(remote)).toThrow(/TLS/);
    expect(() => loadConfig({ ...remote, ALLOW_PLAINTEXT_REDIS: 'yes' })).toThrow(/TLS/); // the old opt-out is gone
    expect(loadConfig({ ...env, REDIS_URL: 'rediss://default:pw@redis-1.example.com:6380' }).redisUrl).toMatch(/^rediss:/);
    expect(loadConfig({ ...env, REDIS_URL: 'redis://default:pw@127.0.0.1:6379' }).redisUrl).toMatch(/^redis:/);
  });

  it('keeps the path of a site served under one', () => {
    expect(loadConfig({ ...env, PUBLIC_BASE_URL: 'https://example.org/pengepassportph/' }).publicBaseUrl).toBe(
      'https://example.org/pengepassportph',
    );
    for (const bad of ['https://example.org/app?x=1', 'https://example.org/app#x', 'https://u:p@example.org/', 'https://example.org/a%20b', 'nope']) {
      expect(() => loadConfig({ ...env, PUBLIC_BASE_URL: bad })).toThrow(ConfigError);
    }
  });
});

describe('R2 sink', () => {
  const scan: Scan = {
    schema: 1,
    runId: 'mfz1-abc123',
    startedAt: '2026-09-27T02:10:00.000Z',
    finishedAt: '2026-09-27T02:12:30.000Z',
    source: { host: 'passport.gov.ph', client: 'test' },
    healthy: true,
    problems: [],
    sites: [],
    groups: [],
  };

  const keyOf = (runId: string, startedAt: string, kind: 'full' | 'changes' = 'changes') => recordKey('scans', { runId, startedAt, kind });
  const body = (value: unknown) => gzipSync(JSON.stringify(value));

  it('uses Hive-style keys that need no escaping', () => {
    expect(keyOf(scan.runId, scan.startedAt)).toBe('scans/v2/date=2026-09-27/2026-09-27T02-10-00-000Z_mfz1-abc123.changes.json.gz');
    expect(recordKey('scans-abroad', { ...scan, kind: 'full' })).toBe('scans-abroad/v2/date=2026-09-27/2026-09-27T02-10-00-000Z_mfz1-abc123.full.json.gz');
    expect(keyOf(scan.runId, scan.startedAt)).toMatch(/^[A-Za-z0-9._=/-]+$/);
  });

  it('caps the spool during a long outage, dropping the oldest records', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const down = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch: down, maxSpoolFiles: 3 });
    for (let i = 0; i < 5; i++) {
      expect(await sink.store(keyOf(`run${i}`, `2026-09-27T02:1${i}:00.000Z`), body(scan))).toBe('spooled');
    }
    const left = (await readdir(spoolDir)).sort();
    expect(left).toHaveLength(3);
    expect(left[0]).toContain('run2');
  });

  it('spools a record at once with no time left to upload it, and gives an upload only the time it has', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    let calls = 0;
    // R2 that never answers, until the upload gives up.
    const stalled = (async (_: unknown, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch: stalled });
    expect(await sink.store(keyOf('run1', '2026-09-27T02:10:00.000Z'), body(scan), 0)).toBe('spooled');
    expect(calls).toBe(0);
    const began = Date.now();
    expect(await sink.store(keyOf('run2', '2026-09-27T02:15:00.000Z'), body(scan), 50)).toBe('spooled');
    expect(calls).toBe(1);
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it('says a record was lost when the full spool drops it (it sorts first after the clock was set back)', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const down = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch: down, maxSpoolFiles: 2 });
    expect(await sink.store(keyOf('run1', '2026-09-27T02:30:00.000Z'), body(scan))).toBe('spooled');
    expect(await sink.store(keyOf('run2', '2026-09-27T02:35:00.000Z'), body(scan))).toBe('spooled');
    expect(await sink.store(keyOf('run3', '2026-09-27T02:05:00.000Z'), body(scan))).toBe('lost');
  });

  it('drops the oldest records by when they ran, whatever their stream, and says which', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const down = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;
    const dropped: string[] = [];
    const sink = r2Sink({ endpoint: 'https://r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch: down, maxSpoolFiles: 2, onDropped: async (keys) => void dropped.push(...keys) });
    const home = keyOf('run1', '2026-09-27T02:10:00.000Z');
    const abroadLater = recordKey('scans-abroad', { runId: 'run2', startedAt: '2026-09-27T02:15:00.000Z', kind: 'changes' });
    const homeLatest = keyOf('run3', '2026-09-27T02:20:00.000Z');
    for (const key of [home, abroadLater, homeLatest]) await sink.store(key, body(scan));
    // "scans-abroad/…" sorts before "scans/…" by name, but ran after it: the home record goes.
    expect(dropped).toEqual([home]);
    const left = (await readSpool(spoolDir, '')).map((r) => r.key).sort();
    expect(left).toEqual([abroadLater, homeLatest].sort());
  });

  it('keeps what it would drop when it cannot note the records as lost', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const down = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;
    const onDropped = async () => {
      throw new Error('redis down');
    };
    const sink = r2Sink({ endpoint: 'https://r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch: down, maxSpoolFiles: 1, onDropped });
    expect(await sink.store(keyOf('run1', '2026-09-27T02:10:00.000Z'), body(scan))).toBe('spooled');
    expect(await sink.store(keyOf('run2', '2026-09-27T02:15:00.000Z'), body(scan))).toBe('spooled');
    // Over the cap for now, rather than losing a record without a trace.
    expect(await readdir(spoolDir)).toHaveLength(2);
  });

  it('reads back the records waiting in the spool under a prefix', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const down = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch: down });
    await sink.store(keyOf('run1', '2026-09-27T02:10:00.000Z', 'full'), body({ n: 1 }));
    await sink.store(keyOf('run2', '2026-09-28T02:10:00.000Z', 'full'), body({ n: 2 }));
    const day = await readSpool(spoolDir, 'scans/v2/date=2026-09-27/');
    expect(day.map((r) => r.key)).toEqual([keyOf('run1', '2026-09-27T02:10:00.000Z', 'full')]);
    expect(JSON.parse(gunzipSync(day[0]!.body).toString())).toEqual({ n: 1 });
    expect(await readSpool(join(spoolDir, 'nowhere'), 'scans/')).toEqual([]);
    // A record sent (and removed) between listing and reading is skipped: the R2 listing
    // that follows has it. A link to nothing lists but won't read, as such a file would.
    await symlink(join(spoolDir, 'gone'), join(spoolDir, 'scans~v2~date=2026-09-27~2026-09-27T02-11-00-000Z_gone.full.json.gz'));
    expect((await readSpool(spoolDir, 'scans/v2/date=2026-09-27/')).map((r) => r.key)).toEqual([keyOf('run1', '2026-09-27T02:10:00.000Z', 'full')]);
    // Anything but a missing spool is an error, not an empty day.
    const file = join(spoolDir, 'a-file');
    await writeFile(file, 'not a directory');
    await expect(readSpool(file, 'scans/')).rejects.toThrow();
  });

  it('spends at most its time on the spool, and leaves the rest for the next run', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    let up = false;
    let clock = 0;
    const puts: string[] = [];
    const fetch = (async (req: Request) => {
      if (!up) return new Response('down', { status: 503 });
      clock += 20_000; // a slow R2: 20 s a record
      puts.push(req.url);
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://acct.r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch, now: () => clock });
    for (let i = 0; i < 5; i++) await sink.store(keyOf(`run${i}`, `2026-09-27T02:1${i}:00.000Z`), body(scan));
    up = true;
    await sink.flush!(30_000);
    // The first takes 20 s; the second is given only the 10 s left (a real one that
    // slow would be cut off); then the budget is spent and the rest wait.
    expect(puts).toHaveLength(2);
    expect(await readdir(spoolDir)).toHaveLength(3);
  });

  it('says a record was lost when it can be neither uploaded nor spooled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const spoolDir = join(dir, 'not-a-directory');
    await writeFile(spoolDir, 'a file where the spool should be');
    const down = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch: down });
    expect(await sink.store(keyOf('run1', scan.startedAt), body(scan))).toBe('lost');
  });

  it('uploads what was spooled when asked, with nothing new to store', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    let up = false;
    const puts: string[] = [];
    const fetch = (async (req: Request) => {
      if (!up) return new Response('down', { status: 503 });
      puts.push(req.url);
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://acct.r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch });
    expect(await sink.store(keyOf('run1', scan.startedAt, 'full'), body(scan))).toBe('spooled');
    up = true;
    await sink.flush!();
    expect(await readdir(spoolDir)).toEqual([]);
    expect(puts).toEqual(['https://acct.r2.example/b/scans/v2/date=2026-09-27/2026-09-27T02-10-00-000Z_run1.full.json.gz']);
  });

  it('reads an object back, and fails on an error', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    let status = 200;
    const seen: string[] = [];
    const fetch = (async (req: Request) => {
      seen.push(`${req.method} ${req.url}`);
      return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : 'no', { status });
    }) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://acct.r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch });
    expect([...(await sink.getObject!('scans/v2/date=2026-09-27/x.full.json.gz'))]).toEqual([1, 2, 3]);
    expect(seen).toEqual(['GET https://acct.r2.example/b/scans/v2/date=2026-09-27/x.full.json.gz']);
    status = 404;
    await expect(sink.getObject!('scans/v2/date=2026-09-27/y.full.json.gz')).rejects.toThrow('R2 GET 404');
  });

  it('deletes an object, and counts one that is not there as deleted', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const seen: { method: string; url: string }[] = [];
    let status = 204;
    const fetch = (async (req: Request) => {
      seen.push({ method: req.method, url: req.url });
      return new Response(status === 204 ? null : '', { status });
    }) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://acct.r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch });
    await sink.deleteObject!('backups/subscribers/date=2026-09-13/subscribers.json.gz');
    expect(seen).toEqual([{ method: 'DELETE', url: 'https://acct.r2.example/b/backups/subscribers/date=2026-09-13/subscribers.json.gz' }]);
    status = 404;
    await sink.deleteObject!('backups/subscribers/date=2026-09-12/subscribers.json.gz');
    status = 403;
    await expect(sink.deleteObject!('backups/x.json.gz')).rejects.toThrow('R2 DELETE 403');
    for (const key of ['../escape', 'backups/../../other-bucket/x', './x', '/x', 'a//b', 'a b']) {
      await expect(sink.deleteObject!(key)).rejects.toThrow('unsafe object key');
      await expect(sink.putObject!(key, new Uint8Array([1]), 'application/gzip')).rejects.toThrow('unsafe object key');
    }
  });

  it('lists every key under a prefix, page by page', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const urls: string[] = [];
    const fetch = (async (req: Request) => {
      urls.push(req.url);
      const second = new URL(req.url).searchParams.get('continuation-token') === 'next';
      const body = second
        ? '<ListBucketResult><Contents><Key>backups/b.json.gz</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'
        : '<ListBucketResult><Contents><Key>backups/a.json.gz</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>';
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://acct.r2.example', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch });
    expect(await sink.listObjects!('backups/')).toEqual(['backups/a.json.gz', 'backups/b.json.gz']);
    expect(new URL(urls[0]!).searchParams.get('prefix')).toBe('backups/');
    expect(urls).toHaveLength(2);
  });

  it('signs uploads, spools them when R2 is down, and catches up later', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'penge-spool-'));
    const puts: { url: string; auth: string | null; body: Buffer }[] = [];
    let up = false;
    const fetch = (async (req: Request) => {
      if (!up) return new Response('down', { status: 503 });
      puts.push({ url: req.url, auth: req.headers.get('authorization'), body: Buffer.from(await req.arrayBuffer()) });
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    const sink = r2Sink({ endpoint: 'https://acct.r2.example/', bucket: 'pengepassportph', accessKeyId: 'AK', secretAccessKey: 'SK', spoolDir, log: silentLog, fetch });

    expect(await sink.store(keyOf(scan.runId, scan.startedAt, 'full'), body(scan))).toBe('spooled');
    expect(await readdir(spoolDir)).toHaveLength(1);

    up = true;
    const later = { ...scan, runId: 'mfz2-def456', startedAt: '2026-09-27T02:20:00.000Z' };
    expect(await sink.store(keyOf(later.runId, later.startedAt), body(later))).toBe('uploaded');
    // Storing sends only its own record; the spool waits for the run's flush.
    expect(await readdir(spoolDir)).toHaveLength(1);
    await sink.flush!();
    expect(await readdir(spoolDir)).toEqual([]);
    expect(puts.map((p) => p.url)).toEqual([
      'https://acct.r2.example/pengepassportph/scans/v2/date=2026-09-27/2026-09-27T02-20-00-000Z_mfz2-def456.changes.json.gz',
      'https://acct.r2.example/pengepassportph/scans/v2/date=2026-09-27/2026-09-27T02-10-00-000Z_mfz1-abc123.full.json.gz',
    ]);
    expect(puts[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request/);
    expect(JSON.parse(gunzipSync(puts[1]!.body).toString())).toEqual(scan);
  });
});

describe('rate limits', () => {
  it('cannot be doubled by a burst either side of a window boundary', async () => {
    const kv = new MemoryKv();
    const limit = { bucket: 't', max: 3, windowSeconds: 3600 };
    const boundary = Date.parse('2026-09-28T00:00:00Z');
    const allowed = [];
    for (const at of [boundary - 3000, boundary - 2000, boundary - 1000, boundary + 1000, boundary + 2000, boundary + 3000]) {
      allowed.push(await hit(kv, limit, 'x', at));
    }
    expect(allowed.filter(Boolean)).toHaveLength(3);
    // An hour after the burst, the budget is back.
    expect(await hit(kv, limit, 'x', boundary + 3600_000 + 5000)).toBe(true);
  });
});

describe('memory store', () => {
  it('expires keys and honours NX like Redis', async () => {
    let t = 0;
    const kv = new MemoryKv(() => t);
    expect(await kv.set('a', '1', { nx: true, ttlSeconds: 10 })).toBe(true);
    expect(await kv.set('a', '2', { nx: true })).toBe(false);
    t = 10_000;
    expect(await kv.get('a')).toBeNull();
    expect(await kv.incr('c', 5)).toBe(1);
    t = 14_000;
    expect(await kv.incr('c', 5)).toBe(2);
    t = 15_000;
    expect(await kv.incr('c', 5)).toBe(1);
  });
});

describe('telling a refused email from one that may have gone out', () => {
  // Shaped like nodemailer's own errors (smtp-connection: _formatError keeps Node's socket error).
  const error = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
  it.each([
    ['the server refused the recipient', error('Recipient command failed: 550 5.1.1 unknown', { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }), true],
    ['the server refused the message after DATA', error('Message failed: 452 4.3.1 full', { code: 'EMESSAGE', responseCode: 452, command: 'DATA' }), true],
    ['the mail server is down', error('connect ECONNREFUSED 127.0.0.1:25', { code: 'ESOCKET', syscall: 'connect', command: 'CONN' }), true],
    ['an address the library rejects before sending', error('Invalid recipient', { code: 'EENVELOPE', command: 'API' }), true],
    ['the connection drops part-way', error('Connection closed unexpectedly', { code: 'ECONNECTION', command: 'CONN' }), false],
    ['a timeout while sending', error('Timeout', { code: 'ETIMEDOUT', command: 'CONN' }), false],
    ['a socket error after connecting', error('read ECONNRESET', { code: 'ESOCKET', syscall: 'read', command: 'CONN' }), false],
    ['anything else', new Error('boom'), false],
  ])('%s', (_what, err, refused) => {
    expect(wasRefused(err)).toBe(refused);
  });
});

describe('log lines', () => {
  it('never carry an email address, even one quoted by the mail server', () => {
    const smtp = Object.assign(new Error('Recipient command failed: 550 5.1.1 <ana.cruz+alerts@example.com.ph>: Recipient address rejected'), { code: 'EENVELOPE' });
    const text = line('error', 'alert email refused', { err: smtp, nested: { to: 'juan@example.com' }, list: ['x@y.co'] });
    expect(text).not.toMatch(/@/);
    expect(JSON.parse(text)).toMatchObject({ level: 'error', msg: 'alert email refused', err: expect.stringContaining('<address>'), nested: { to: '<address>' } });
  });
});
