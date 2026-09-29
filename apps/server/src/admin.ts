// Operator commands, run on the server as the penge user:
//
//   node admin.mjs backup > subscribers.json          every subscriber, still encrypted
//   node admin.mjs restore subscribers.json[.gz] --yes
//   node admin.mjs scans 2026-10-01 [abroad] > day.jsonl
//
// The daily backups the checker stores in R2 (backups/subscribers/date=…/)
// restore the same way once downloaded. `scans` rebuilds a UTC day's scan
// records (record.ts), from R2 and from the spool, into the full picture at
// each one, a line of JSON each, and says on stderr if any record is missing.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isCalendarDate } from '@penge/contracts';
import { type Backup, exportSubscribers, importSubscribers } from './backup.ts';
import { loadConfig, requireR2 } from './config.ts';
import { K } from './keys.ts';
import { connectRedis } from './kv.ts';
import { silentLog } from './log.ts';
import { r2Sink, readSpool } from './r2.ts';
import { rebuild, RECORD_SCHEMA, type ScanRecord } from './record.ts';

const USAGE = 'usage: admin.mjs backup > file.json | admin.mjs restore <file.json[.gz]> --yes | admin.mjs scans <YYYY-MM-DD> [abroad] > day.jsonl\n';
const [command, file, confirm] = process.argv.slice(2);
if (command !== 'backup' && command !== 'restore' && command !== 'scans') {
  process.stderr.write(USAGE);
  process.exit(2);
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
if (command === 'restore' && (!file || confirm !== '--yes')) {
  process.stderr.write('restore overwrites subscribers with the same ids; add --yes to go ahead\n');
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
      const restored = await importSubscribers(kv, JSON.parse(data.toString('utf8')) as Backup);
      process.stderr.write(`restored ${restored} subscribers\n`);
    }
  } finally {
    await kv.close();
  }
}
