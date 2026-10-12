// Operator commands, run on the server as the penge user:
//
//   node admin.mjs backup > subscribers.json          every subscriber, still encrypted
//   node admin.mjs restore subscribers.json[.gz] --yes
//   node admin.mjs scans 2026-10-01 [abroad] > day.jsonl
//   node admin.mjs device-cleanup                      notification clean-up (the rollback's pre-step)
//   node admin.mjs channel-inspect                     what the channel release left (read only)
//   node admin.mjs channel-dump > channel-keys.json    exactly those keys, for the backup
//   node admin.mjs channel-clean --yes                 cleaned by the migration table (stops for the owner first)
//
// The daily backups the checker stores in R2 (backups/subscribers/date=…/)
// restore the same way once downloaded. `scans` rebuilds a UTC day's scan
// records (record.ts), from R2 and from the spool, into the full picture at
// each one, a line of JSON each, and says on stderr if any record is missing.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isCalendarDate } from '@penge/contracts';
import { exportSubscribers, importSubscribers } from './backup.ts';
import { loadConfig, requireR2 } from './config.ts';
import { K } from './keys.ts';
import { connectRedis } from './kv.ts';
import { stampAt } from './clock.ts';
import { deviceCleanup } from './devices/cleanup.ts';
import { acquireLock, releaseLock } from './devices/lock.ts';
import { log, silentLog } from './log.ts';
import { cleanChannels, dumpChannels, inspectChannels } from './migrate.ts';
import { r2Sink, readSpool } from './r2.ts';
import { rebuild, RECORD_SCHEMA, type ScanRecord } from './record.ts';

const COMMANDS = ['backup', 'restore', 'scans', 'device-cleanup', 'channel-inspect', 'channel-dump', 'channel-clean'];
const USAGE =
  'usage: admin.mjs backup > file.json | admin.mjs restore <file.json[.gz]> --yes | admin.mjs scans <YYYY-MM-DD> [abroad] > day.jsonl | admin.mjs device-cleanup | admin.mjs channel-inspect | admin.mjs channel-dump > channel-keys.json | admin.mjs channel-clean --yes\n';
const [command, file, confirm] = process.argv.slice(2);
if (!command || !COMMANDS.includes(command)) {
  process.stderr.write(USAGE);
  process.exit(2);
}
// Leaving the channel design: these read only REDIS_URL (not loadConfig, which refuses the channel release's
// PUSH_OWNER_EMAILS), so they run from the new release's unpacked bundle with production's current server.env.
if (command === 'channel-inspect' || command === 'channel-dump' || command === 'channel-clean') {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    process.stderr.write('REDIS_URL is not set\n');
    process.exit(2);
  }
  // Written in full before the process ends: a dump through a pipe (ssh, gzip) is never cut short.
  const out = (text: string) => new Promise<void>((resolve, reject) => process.stdout.write(text, (err) => (err ? reject(err) : resolve())));
  const kv = await connectRedis(url, (err) => process.stderr.write(`redis: ${err.message}\n`));
  try {
    const inspection = await inspectChannels(kv);
    if (command === 'channel-inspect') await out(`${JSON.stringify(inspection, null, 2)}\n`);
    else if (command === 'channel-dump') await out(`${JSON.stringify(await dumpChannels(kv, inspection))}\n`);
    else if (file !== '--yes') {
      await out(`${JSON.stringify(inspection, null, 2)}\nadd --yes to clean\n`);
      process.exitCode = 2;
    } else await out(`${JSON.stringify(await cleanChannels(kv, inspection))}\n`);
  } finally {
    await kv.close();
  }
  process.exit();
}

if (command === 'scans') {
  const day = file ?? '';
  // A real date: 2026-02-31 would list nothing and look like a quiet day.
  if (!isCalendarDate(day) || (confirm !== undefined && confirm !== 'abroad')) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const config = loadConfig();
  const sink = r2Sink({ ...requireR2(config), spoolDir: config.spoolDir, log: silentLog });
  const stream = confirm === 'abroad' ? 'scans-abroad' : 'scans';
  const prefix = `${stream}/v${RECORD_SCHEMA}/date=${day}/`;
  // Records still waiting in the spool (R2 was down) are part of the day too. The
  // spool is read first: a running checker only ever moves a record from it to R2,
  // so one it moves meanwhile is caught by one read or the other.
  const spooled = await readSpool(config.spoolDir, prefix);
  const keys = (await sink.listObjects!(prefix)).sort();
  const records: { key: string; record: ScanRecord }[] = [];
  for (const key of keys) records.push({ key, record: JSON.parse(gunzipSync(await sink.getObject!(key)).toString('utf8')) as ScanRecord });
  const inR2 = new Set(keys);
  const waiting = spooled.filter((r) => !inR2.has(r.key));
  for (const r of waiting) records.push({ key: r.key, record: JSON.parse(gunzipSync(r.body).toString('utf8')) as ScanRecord });
  // A record said lost from another day may be in R2 after all (an upload that timed
  // out on our side but landed): look before calling it a gap.
  const here = new Set(records.map((r) => r.key));
  const stored = new Set<string>();
  for (const key of new Set(records.flatMap((r) => r.record.lost ?? []))) {
    if (!here.has(key) && (await sink.listObjects!(key)).includes(key)) stored.add(key);
  }
  const { states, gaps } = rebuild(records, { stored });
  // Each line waits for room in the pipe, so nothing is cut off when it is slow to read.
  const write = (text: string) => new Promise<void>((done) => (process.stdout.write(text) ? done() : process.stdout.once('drain', done)));
  for (const state of states) await write(`${JSON.stringify(state)}\n`);
  process.stderr.write(
    `${records.length} records (${waiting.length} still in the spool), ${states.length} states${gaps.length ? `, ${gaps.length} gaps:\n${gaps.join('\n')}` : ''}\n`,
  );
  process.exitCode = gaps.length ? 1 : 0;
}
if (command === 'device-cleanup') {
  // The rollback's pre-step (deploy/README.md): an older release's checker does not clean notification alerts. It takes
  // its own lock (a "cleanup-…" run: pp:lock:device-cleanup), never the checker's, logs a failure and always exits 0,
  // so it can never stop the old checker or email. It does nothing while any checker run holds pp:lock:check (only this
  // release's checker touches pp:dev:*, and its own run cleans up anyway).
  const runId = `cleanup-${Date.now().toString(36)}`;
  try {
    const config = loadConfig();
    // node-redis retries even its first connection for ever: past its 10 s connect timeout, the clean-up is given up
    // (process.exit below ends the retries), so the rollback's pre-step never waits on a Valkey that is down.
    const kv = await Promise.race([
      connectRedis(config.redisUrl, (err) => process.stderr.write(`redis: ${err.message}\n`)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('could not connect to Valkey within 10 s')), 10_000).unref()),
    ]);
    try {
      if (await kv.get(K.checkLock)) {
        log.warn('a check is running; device clean-up skipped');
      } else if (await acquireLock(kv, runId, 300)) {
        try {
          const r = await deviceCleanup({ kv, log, now: Date.now, stampNow: () => stampAt(Date.now()) }, runId);
          log.info('device clean-up done', { ...r });
        } finally {
          await releaseLock(kv, runId);
        }
      } else {
        log.warn('another device clean-up is running; skipped');
      }
    } finally {
      await kv.close().catch(() => {});
    }
  } catch (err) {
    log.error('device clean-up failed', { err: err as Error });
  }
  process.exit(0);
}
if (command === 'restore' && (!file || confirm !== '--yes')) {
  process.stderr.write('restore puts subscribers back without displacing anyone; add --yes to go ahead\n');
  process.exit(2);
}

if (command === 'backup' || command === 'restore') {
  const config = loadConfig();
  const kv = await connectRedis(config.redisUrl, (err) => process.stderr.write(`redis: ${err.message}\n`));
  try {
    if (command === 'backup') {
      const raw = await kv.get(K.sites);
      const siteIds = raw ? (JSON.parse(raw) as { id: number }[]).map((s) => s.id) : [];
      process.stdout.write(`${JSON.stringify(await exportSubscribers(kv, siteIds, Date.now()))}\n`);
    } else {
      let data = readFileSync(file!);
      if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
      const result = await importSubscribers(kv, config.keys, JSON.parse(data.toString('utf8')) as unknown);
      process.stderr.write(`restored ${result.restored} subscribers; ${result.emailOff} had email off and were left out\n`);
      const why = { 'address-taken': 'its address belongs to another subscriber now', 'id-taken': 'its id belongs to another address now', 'email-off-now': 'it has email off now; a backup never turns it back on', 'damaged-keys': 'a key it needs has the wrong type; nothing of it was written (see the runbook)' };
      for (const s of result.skipped) process.stderr.write(`skipped ${s.id}: ${why[s.reason]}\n`);
    }
  } finally {
    await kv.close();
  }
}
