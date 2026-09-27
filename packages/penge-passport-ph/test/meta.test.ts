import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { userAgent } from '../src/client.js';
import { CLI_ALIAS, DISPLAY_NAME, ENV_PREFIX, HOMEPAGE, NAME, REPOSITORY, VERSION } from '../src/meta.js';
// @ts-expect-error plain .mjs without types
import * as canary from '../../../scripts/canary/config.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  homepage: string;
  bin: Record<string, string>;
  repository: { url: string };
  bugs: { url: string };
};

describe('package identity', () => {
  it('matches package.json everywhere it is repeated', () => {
    expect(NAME).toBe(pkg.name);
    expect(VERSION).toBe(pkg.version);
    expect(pkg.bin).toEqual({ [NAME]: './dist/cli.js', [CLI_ALIAS]: './dist/cli.js' });
    expect(NAME).toBe(DISPLAY_NAME.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
    expect(pkg.homepage).toBe(HOMEPAGE);
    expect(pkg.repository.url).toBe(`git+${REPOSITORY}.git`);
    expect(pkg.bugs.url).toBe(`${REPOSITORY}/issues`);
  });

  it('is mirrored exactly by the build-independent canary config', () => {
    expect(canary.NAME).toBe(NAME);
    expect(canary.DISPLAY_NAME).toBe(DISPLAY_NAME);
    expect(canary.ENV_PREFIX).toBe(ENV_PREFIX);
    expect(canary.ISSUE_TITLE).toContain(DISPLAY_NAME);
  });

  it('builds the User-Agent from it, with an optional contact', () => {
    expect(userAgent()).toBe(`${NAME}/${VERSION} (+${HOMEPAGE}; read-only availability checker)`);
    expect(userAgent('me@example.com')).toMatch(/; me@example\.com\)$/);
  });
});
