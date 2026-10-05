// The local push test stack's server: the real API and the real checker, with a
// throwaway Valkey (or MemoryKv), a capturing mailer, a fake DFA and no R2.
// It never reads .secrets/: its keys live in the directory it is given.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import webpush from 'web-push';
import { createApi } from '../src/api.ts';
import { type CheckDeps, runCheck } from '../src/checker.ts';
import type { PushConfig } from '../src/config.ts';
import { K } from '../src/keys.ts';
import { connectRedis, type Kv, MemoryKv, type WriteOp } from '../src/kv.ts';
import { log } from '../src/log.ts';
import { createLookups } from '../src/lookups.ts';
import { webPushTransport } from '../src/push/sender.ts';
import type { SnapshotSink } from '../src/r2.ts';
import { CaptureMailer } from './capture-mailer.ts';
import { FakeDfa } from './fake-upstream.ts';

const BASE = 'http://localhost:4173/pengepassportph';

function secrets(dir: string) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'secrets.json');
  if (!existsSync(file)) {
    const vapid = webpush.generateVAPIDKeys();
    const b = () => randomBytes(32).toString('base64');
    writeFileSync(file, JSON.stringify({ email: b(), index: b(), token: b(), vapid }, null, 2), { mode: 0o600 });
  }
  const s = JSON.parse(readFileSync(file, 'utf8')) as { email: string; index: string; token: string; vapid: { publicKey: string; privateKey: string } };
  return {
    keys: { email: Buffer.from(s.email, 'base64'), index: Buffer.from(s.index, 'base64'), token: Buffer.from(s.token, 'base64') },
    vapid: { ...s.vapid, subject: 'mailto:alerts@example.com' },
  };
}

/** Records go nowhere: the local stack has no R2. */
const noSink: SnapshotSink = { store: async () => 'uploaded' };

/** Only the throwaway Valkey that scripts/local-stack.sh starts, and only once it is marked disposable. */
async function localKv(url: string): Promise<Kv> {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '6391' || u.username || u.password) {
    throw new Error('the local stack only uses the throwaway Valkey on 127.0.0.1:6391');
  }
  const kv = await connectRedis(url, (err) => log.error('redis', { err }));
  if ((await kv.get(K.pushTestMark)) !== '1') {
    await kv.close();
    throw new Error('that Valkey is not marked disposable (scripts/local-stack.sh marks it); refusing to use it');
  }
  return kv;
}

export async function buildLocal(o: { kvUrl: string | null; dir: string }) {
  const kv: Kv = o.kvUrl ? await localKv(o.kvUrl) : new MemoryKv();
  const { keys, vapid } = secrets(o.dir);
  const mailer = new CaptureMailer(o.dir);
  const upstream = new FakeDfa();
  const push: PushConfig = { mode: 'live', vapid, ownerEmails: [] };
  const transport = webPushTransport(vapid);
  // Lookups (group dates, hours) answered by the fake DFA: no network here either.
  const lookups = createLookups({ kv, upstream, log });
  const app = createApi({
    kv, keys, mailer, log, publicBaseUrl: BASE, push, pushTransport: transport, lookups,
    // With MemoryKv the API is called in-process (tests): there is no socket to read an address from.
    ...(o.kvUrl ? {} : { clientIp: () => '127.0.0.1' }),
  });
  const deps: CheckDeps = {
    kv, upstream, sink: noSink, mailer, keys, log, publicBaseUrl: BASE,
    mailDailyLimit: 2500, alertsPerSubscriberPerDay: 288, client: 'penge-local', push: { mode: 'live', transport },
  };
  let n = 0;
  const runOnce = () => runCheck({ ...deps, runId: `local${++n}-${Date.now()}` });
  await runOnce(); // the office list and a baseline

  // A local-only route, never part of the production API: opens a date in this
  // process's fake DFA (the one the API's lookups read too) and runs the checker.
  const devApp = new Hono();
  devApp.post('/dev/open', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { office?: unknown; date?: unknown } | null;
    const office = Number(body?.office);
    const date = String(body?.date ?? '');
    if (!Number.isSafeInteger(office) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'office and date' }, 400);
    // A fresh opening every time: first a run that sees the date closed, then one that sees it
    // open; a date is announced once in 3 hours, so forget an earlier announcement of it.
    // Cached lookups for the office (group dates, hours) go too, so a tap sees the date open.
    const clear = async () => {
      const ops: WriteOp[] = [];
      for (let applicants = 1; applicants <= 5; applicants++) {
        ops.push({ op: 'del', key: K.announced(office, applicants, date) }, { op: 'del', key: K.lookup(`dates:${office}:${applicants}`) }, { op: 'del', key: K.lookup(`times:${office}:${date}:${applicants}`) });
      }
      await kv.write(ops);
    };
    upstream.open.set(office, (upstream.open.get(office) ?? []).filter((d) => d !== date));
    await runOnce();
    await clear();
    upstream.open.set(office, [...(upstream.open.get(office) ?? []), date]);
    const report = await runOnce();
    await clear();
    return c.json({ delivery: report.delivery });
  });
  devApp.route('/', app);
  return { app, devApp, kv, mailer, deps, upstream, runOnce, close: () => kv.close() };
}

/**
 * The repository's .local/, from where this file runs (its bundle is .local/dist/local.mjs), so
 * every way of starting it uses the same keys: never the working directory.
 */
export const localDir = () => process.env.PENGE_LOCAL_DIR ?? fileURLToPath(new URL('..', import.meta.url));

if (process.argv[1]?.endsWith('local.mjs')) {
  const stack = await buildLocal({ kvUrl: process.env.PENGE_LOCAL_KV ?? 'redis://127.0.0.1:6391', dir: localDir() });
  serve({ fetch: stack.devApp.fetch, hostname: '127.0.0.1', port: 8787 }, () => log.info('local api on 127.0.0.1:8787'));
}
