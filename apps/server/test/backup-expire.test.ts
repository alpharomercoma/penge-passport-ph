// deploy/penge-backup-expire.sh deletes rollout backups once the expiry time in their name has
// passed, and nothing else: run it on a scratch folder with backups past, at and before their time.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = new URL('../../../deploy/penge-backup-expire.sh', import.meta.url).pathname;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the rollout backup expiry', () => {
  it('deletes only the backups whose expiry has passed, and leaves anything else alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'penge-backups-'));
    const now = Date.now();
    const files = {
      past: `subscribers-x-expires-${stamp(now - 3600_000)}.json`,
      pastEnv: `server.env-x-expires-${stamp(now - 60_000)}`,
      future: `subscribers-y-expires-${stamp(now + 14 * 86_400_000)}.json`,
      soon: `server.env-y-expires-${stamp(now + 3600_000)}`,
      malformed: 'notes-expires-someday.txt',
      unrelated: 'keep-me.json',
      oddSuffix: `notes-expires-${stamp(now - 3600_000)}.json.keep`,
      otherSuffix: `notes-expires-${stamp(now - 3600_000)}.not-a-backup`,
    };
    for (const f of Object.values(files)) writeFileSync(join(dir, f), 'x');
    // Not files: left alone, and they do not stop the run (the expired file sorted after them still goes).
    const folder = `a-expires-${stamp(now - 3600_000)}`;
    mkdirSync(join(dir, folder));
    const link = `b-expires-${stamp(now - 3600_000)}`;
    symlinkSync(join(dir, files.unrelated), join(dir, link));
    const last = `z-expires-${stamp(now - 3600_000)}.json`;
    writeFileSync(join(dir, last), 'x');
    execFileSync('sh', [script], { env: { ...process.env, PENGE_BACKUP_DIR: dir } });
    expect(readdirSync(dir).sort()).toEqual([files.future, files.soon, files.malformed, files.unrelated, files.oddSuffix, files.otherSuffix, folder, link].sort());
  });
});
