// The channel commands run on the server with production's REDIS_URL: whatever goes wrong, they never print it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

// admin.mjs as the release ships it (build.mjs's options), into a scratch folder.
const out = mkdtempSync(join(tmpdir(), 'penge-admin-'));
beforeAll(async () => {
  await build({
    absWorkingDir: join(import.meta.dirname, '..'),
    entryPoints: { admin: 'src/admin.ts' },
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['impit'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'silent',
  });
}, 60_000);

describe('the channel commands', () => {
  it.each(['channel-inspect', 'channel-dump'])('%s never prints a REDIS_URL it cannot use (its password included)', (command) => {
    for (const url of ['redis://user:s3cr3tpass@[::1', 'redis://user:s3cr3tpass@127.0.0.1:1']) {
      const r = spawnSync(process.execPath, [join(out, 'admin.mjs'), command], { env: { ...process.env, REDIS_URL: url }, encoding: 'utf8', timeout: 30_000 });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).not.toContain('s3cr3tpass');
      expect(r.stderr).toMatch(/could not reach Valkey/);
    }
  }, 60_000);

  it.runIf(!!process.env.DEVICE_TEST_VALKEY)('channel-inspect prints its inspection when Valkey answers', () => {
    const r = spawnSync(process.execPath, [join(out, 'admin.mjs'), 'channel-inspect'], { env: { ...process.env, REDIS_URL: process.env.DEVICE_TEST_VALKEY }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ pushKeys: expect.any(Array), stops: expect.any(Array) });
  }, 60_000);
});
