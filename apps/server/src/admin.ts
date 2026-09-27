// Operator commands, run on the server as the penge user:
//
//   node admin.mjs backup > subscribers.json          every subscriber, still encrypted
//   node admin.mjs restore subscribers.json[.gz] --yes
//
// The daily backups the checker stores in R2 (backups/subscribers/date=…/)
// restore the same way once downloaded.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { type Backup, exportSubscribers, importSubscribers } from './backup.ts';
import { loadConfig } from './config.ts';
import { K } from './keys.ts';
import { connectRedis } from './kv.ts';

const [command, file, confirm] = process.argv.slice(2);
if (command !== 'backup' && command !== 'restore') {
  process.stderr.write('usage: admin.mjs backup > file.json | admin.mjs restore <file.json[.gz]> --yes\n');
  process.exit(2);
}
if (command === 'restore' && (!file || confirm !== '--yes')) {
  process.stderr.write('restore overwrites subscribers with the same ids; add --yes to go ahead\n');
  process.exit(2);
}

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
