// npx tsx docs/superpowers/verification/harness/old-check.mts <worktree> [<office> <date>] — that release's own checker
// code against the local Valkey, with the local stack's fake DFA, captured mail and no R2: one run, or, with an office
// and a published date, a run that sees the date closed and one that sees it open (so the opening is emailed).
// For the rollback rehearsal only.
import { join } from 'node:path';
import { FakeDfa } from '../../../../apps/server/dev/fake-upstream.ts';
import { CaptureMailer } from '../../../../apps/server/dev/capture-mailer.ts';
import { noSink, secrets } from '../../../../apps/server/dev/local.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: old-check.mts <worktree of the older release>');
const local = join(import.meta.dirname, '../../../../.local');
const { runCheck } = await import(join(dir, 'apps/server/src/checker.ts'));
const { connectRedis } = await import(join(dir, 'apps/server/src/kv.ts'));
const { log } = await import(join(dir, 'apps/server/src/log.ts'));
const kv = await connectRedis('redis://127.0.0.1:6391', (err: Error) => process.stderr.write(`redis: ${err.message}\n`));
// Only the local stack's Valkey, which carries the disposable mark scripts/local-stack.sh sets.
if ((await kv.get('pp:test:disposable')) !== '1') {
  await kv.close();
  throw new Error('redis://127.0.0.1:6391 is not marked disposable; refusing');
}
const upstream = new FakeDfa();
const run = () =>
  runCheck({
    kv, upstream, sink: noSink, mailer: new CaptureMailer(local), keys: secrets(local).keys, log,
    publicBaseUrl: 'http://localhost:4173/pengepassportph/', mailDailyLimit: 2500, alertsPerSubscriberPerDay: 288, client: 'penge-rollback-rehearsal',
    runId: `rehearsal-${Date.now()}`,
  });
try {
  let report = await run();
  const [office, date] = process.argv.slice(3);
  if (office && date) {
    upstream.open.set(Number(office), [date]);
    report = await run();
  }
  console.log(JSON.stringify({ healthy: report.healthy, emailed: report.delivery?.sent ?? null }));
} finally {
  await kv.close();
}
