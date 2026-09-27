// PengePassportPH canary, reporting. Collects checks and reports them loudly: a ✅/❌/⚠️/⏭ line per check
// on stdout, a Markdown table in the GitHub job summary, an ::error
// annotation per failure, a JSON file for the issue step, and exit code 1.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISPLAY_NAME, RESULTS_DIR } from './config.mjs';

export { RESULTS_DIR };

const ICON = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️' };

export class Report {
  /** @param {string} id short file-safe name, e.g. "api" */
  constructor(id, title) {
    this.id = id;
    this.title = title;
    /** @type {{status: keyof typeof ICON, name: string, detail: string}[]} */
    this.checks = [];
    this.startedAt = new Date();
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  /**
   * Run `fn`. It passes if it returns (its return value is the detail shown),
   * fails if it throws. Returns `{ ok, value }` so later checks can depend on it.
   */
  async check(name, fn) {
    try {
      const value = await fn();
      this.add('pass', name, typeof value === 'string' ? value : (value?.detail ?? ''));
      return { ok: true, value };
    } catch (err) {
      this.add('fail', name, err instanceof Error ? err.message : String(err));
      return { ok: false, value: undefined };
    }
  }

  warn(name, detail) {
    this.add('warn', name, detail);
  }

  skip(name, detail) {
    this.add('skip', name, detail);
  }

  add(status, name, detail) {
    this.checks.push({ status, name, detail });
    const line = `${ICON[status]} ${name}${detail ? ` - ${detail}` : ''}`;
    (status === 'fail' ? console.error : console.log)(line);
    if (process.env.GITHUB_ACTIONS && (status === 'fail' || status === 'warn')) {
      const level = status === 'fail' ? 'error' : 'warning';
      console.log(`::${level} title=${escapeProp(`${DISPLAY_NAME} canary · ${this.title}: ${name}`)}::${escapeData(detail)}`);
    }
  }

  get failed() {
    return this.checks.filter((c) => c.status === 'fail');
  }

  finish() {
    const failed = this.failed.length;
    const headline = failed
      ? `❌ ${DISPLAY_NAME} canary · ${this.title}: ${failed} of ${this.checks.length} checks FAILED`
      : `✅ ${DISPLAY_NAME} canary · ${this.title}: all ${this.checks.filter((c) => c.status === 'pass').length} checks passed`;
    const markdown = [
      `## ${headline}`,
      '',
      '| | Check | Detail |',
      '|---|---|---|',
      ...this.checks.map((c) => `| ${ICON[c.status]} | ${cell(c.name)} | ${cell(c.detail)} |`),
      '',
      failed
        ? `> Something ${DISPLAY_NAME} depends on has changed on passport.gov.ph. Do not trust its results until this is investigated and the package or the pinned expectations are updated. Runbook: docs/canary.md`
        : '',
      '',
    ].join('\n');

    console.log(`\n${headline}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    writeFileSync(join(RESULTS_DIR, `${this.id}.md`), markdown);
    writeFileSync(
      join(RESULTS_DIR, `${this.id}.json`),
      JSON.stringify(
        {
          id: this.id,
          title: this.title,
          startedAt: this.startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          ok: failed === 0,
          checks: this.checks,
        },
        null,
        2,
      ),
    );
    process.exitCode = failed ? 1 : 0;
  }
}

/** Throw with `message` unless `condition` holds. */
export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
