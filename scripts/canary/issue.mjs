#!/usr/bin/env node
// PengePassportPH canary, issue step. Keeps one GitHub issue in sync:
//   node scripts/canary/issue.mjs fail   open it (or comment on the open one)
//   node scripts/canary/issue.mjs pass   comment and close it, if open
// Needs the `gh` CLI with GH_TOKEN (issues: write).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISPLAY_NAME, ISSUE_DRY_RUN, ISSUE_LABEL as LABEL, ISSUE_TITLE } from './config.mjs';
import { RESULTS_DIR } from './report.mjs';

/** Every canary part writes <id>.json; a missing one means that part never reported. */
const REPORTS = ['api', 'ui', 'python'];
const mode = process.argv[2];
if (mode !== 'fail' && mode !== 'pass') {
  console.error('usage: issue.mjs fail|pass');
  process.exit(2);
}

const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : '(local run)';

const gh = (...args) => {
  if (!ISSUE_DRY_RUN) return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  console.log(`[dry run] gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (args[1] === 'list') return '[]';
  if (args[1] === 'view') return '{"body":"","comments":[]}';
  return 'https://github.com/OWNER/REPO/issues/0';
};

const open = JSON.parse(
  gh('issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '1'),
);
const existing = open[0]?.number;

if (mode === 'pass') {
  if (existing) {
    gh('issue', 'close', String(existing), '--comment', `✅ Canary passing again: ${runUrl}`);
    console.log(`closed #${existing}`);
  }
  process.exit(0);
}

const reports = REPORTS
  .map((id) => join(RESULTS_DIR, `${id}.json`))
  .filter(existsSync)
  .map((f) => JSON.parse(readFileSync(f, 'utf8')));
const failures = reports.flatMap((r) =>
  r.checks.filter((c) => c.status === 'fail').map((c) => `- ❌ **${r.title}: ${c.name}**: ${c.detail}`),
);
const missing = REPORTS.filter((id) => !reports.some((r) => r.id === id));
const summaries = REPORTS
  .map((id) => join(RESULTS_DIR, `${id}.md`))
  .filter(existsSync)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

// Same failing checks as last time: the red run is enough, don't pile on comments.
const fingerprint = createHash('sha256')
  .update(JSON.stringify([...reports.flatMap((r) => r.checks.filter((c) => c.status === 'fail').map((c) => `${r.id}:${c.name}`)), ...missing].sort()))
  .digest('hex')
  .slice(0, 16);
const marker = `<!-- canary-failures:${fingerprint} -->`;

const body = [
  `The scheduled canary found that passport.gov.ph no longer behaves the way ${DISPLAY_NAME} expects.`,
  `Treat the checker's output as unreliable until this is resolved.`,
  '',
  `**Run:** ${runUrl}`,
  '',
  '### Failing checks',
  ...failures,
  ...(missing.length
    ? [
        `- ❌ No report from: ${missing.join(', ')}. A setup step (install, build or Chromium) ` +
          'failed or the check crashed before reporting; see the run log.',
      ]
    : []),
  ...(failures.length || missing.length ? [] : ['- ❌ The job failed outside the checks; see the run log.']),
  '',
  '### Full results',
  summaries || '_none_',
  '',
  'Screenshots and raw results are in the run\'s `canary-results` artifact. What to do next: docs/canary.md.',
  marker,
].join('\n');
// Setup can fail before any check has created the results directory.
mkdirSync(RESULTS_DIR, { recursive: true });
const bodyFile = join(RESULTS_DIR, 'issue-body.md');
writeFileSync(bodyFile, body.length > 60_000 ? `${body.slice(0, 60_000)}\n\n… (truncated)` : body);

if (existing) {
  const issue = JSON.parse(gh('issue', 'view', String(existing), '--json', 'body,comments'));
  // Compare with the latest canary report, ignoring comments people added since.
  const latestReport = [issue.body ?? '', ...(issue.comments ?? []).map((c) => c.body ?? '')]
    .filter((b) => b.includes('<!-- canary-failures:'))
    .at(-1);
  if (latestReport?.includes(marker)) {
    console.log(`#${existing} already reports these failures; not commenting again`);
  } else {
    gh('issue', 'comment', String(existing), '--body-file', bodyFile);
    console.log(`commented on #${existing}`);
  }
} else {
  gh('label', 'create', LABEL, '--color', 'B60205', '--description', `${DISPLAY_NAME} canary: passport.gov.ph changed`, '--force');
  const count = failures.length || 1;
  const url = gh(
    'issue',
    'create',
    '--title',
    `${ISSUE_TITLE} (${count} check${count === 1 ? '' : 's'} failing)`,
    '--label',
    LABEL,
    '--body-file',
    bodyFile,
  );
  console.log(`opened ${url}`);
}
