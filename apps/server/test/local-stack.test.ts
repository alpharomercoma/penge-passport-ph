import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLocal } from '../dev/local.ts';

describe('the local stack', () => {
  it('never builds the DFA client, and has no R2', async () => {
    for (const file of ['local.ts', 'alert.ts', 'fake-upstream.ts']) {
      const source = readFileSync(join(__dirname, '../dev', file), 'utf8');
      // No DFA client and no R2 client is made (the lookups factory is fine: it gets the fake).
      expect(source).not.toMatch(/new PengePassportPH|r2Sink\(|requireR2\(/);
    }
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    expect(stack.deps.sink.putObject).toBeUndefined();
    expect(stack.deps.upstream.constructor.name).toBe('FakeDfa');
    await stack.close();
  });

  it('does not read .secrets or server.env', () => {
    for (const file of ['local.ts', 'alert.ts', 'capture-mailer.ts', 'fake-upstream.ts']) {
      // A path in a string, not a word in a comment.
      expect(readFileSync(join(__dirname, '../dev', file), 'utf8')).not.toMatch(/['"`][^'"`\n]*(\.secrets|server\.env)/);
    }
  });

  it('refuses any Valkey but the marked local one', async () => {
    await expect(buildLocal({ kvUrl: 'redis://db.example.com:6379', dir: mkdtempSync(join(tmpdir(), 'penge-local-')) })).rejects.toThrow(/only uses the throwaway Valkey/);
    await expect(buildLocal({ kvUrl: 'redis://127.0.0.1:6379', dir: mkdtempSync(join(tmpdir(), 'penge-local-')) })).rejects.toThrow(/only uses the throwaway Valkey/);
  });

  it('answers group dates and hours from the fake DFA', async () => {
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    const day = stack.upstream.published()[0]!;
    stack.upstream.open.set(486, [day]);
    const ua = { headers: { 'user-agent': 'Mozilla/5.0 Chrome/141' } };
    const dates = await stack.app.request('/api/offices/486/dates?applicants=2', ua);
    expect(dates.status).toBe(200);
    expect(((await dates.json()) as { openDates: string[] }).openDates).toEqual([day]);
    const times = await stack.app.request(`/api/offices/486/times?date=${day}&applicants=1`, ua);
    expect(times.status).toBe(200);
    expect(((await times.json()) as { slots: { available: boolean }[] }).slots[0]!.available).toBe(true);
    await stack.close();
  });

  it('opens a date for the running API through its local-only route, past a cached closed answer, every time', async () => {
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    const day = stack.upstream.published()[1]!;
    const ua = { headers: { 'user-agent': 'Mozilla/5.0 Chrome/141' } };
    // A visitor looked first: the closed answer is cached.
    expect(((await (await stack.app.request('/api/offices/486/dates?applicants=1', ua)).json()) as { openDates: string[] }).openDates).toEqual([]);
    const open = () => stack.devApp.request('/dev/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ office: 486, date: day }) });
    expect((await open()).status).toBe(200);
    expect(((await (await stack.app.request('/api/offices/486/dates?applicants=1', ua)).json()) as { openDates: string[] }).openDates).toEqual([day]);
    // A second trigger for the same date is a fresh opening again.
    const second = (await (await open()).json()) as { delivery: { push: unknown } | null };
    expect(second.delivery).not.toBeNull();
    await stack.close();
  });

  it('captures a confirmation email with its link instead of sending it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'penge-local-'));
    const stack = await buildLocal({ kvUrl: null, dir });
    const res = await stack.app.request('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/141' },
      body: JSON.stringify({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: false } }),
    });
    expect(res.status).toBe(202);
    expect(stack.mailer.captured.at(-1)!.text).toMatch(/\/confirm#token=/);
    expect(readdirSync(join(dir, 'mail'))).toEqual(['001-confirm.txt']);
    await stack.close();
  });

  it('runs the real checker against the fake DFA and alerts by email', async () => {
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    const sub = await stack.app.request('/api/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/141' },
      body: JSON.stringify({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: false } }),
    });
    expect(sub.status).toBe(202);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(stack.mailer.captured.at(-1)!.text)![1];
    await stack.app.request('/api/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, acknowledge: { emailOn: true, pushOn: false } }) });
    stack.upstream.open.set(486, ['2026-10-09']);
    await stack.runOnce();
    expect(stack.mailer.captured.at(-1)!.kind).toBe('alert');
    await stack.close();
  });
});
