// One checker run: `node dist/check.mjs`, started by a systemd timer.
// Exit codes: 0 done (or another run was in progress), 1 crashed, 3 the scan
// failed its health checks (nothing was emailed).
import { NAME, PengePassportPH, VERSION } from 'penge-passport-ph';
import { ABROAD_REQUESTS_PER_HOUR, abroadStateDir, SCAN_REQUESTS_PER_HOUR, scanStateDir } from './budget.ts';
import { runCheck } from './checker.ts';
import { loadConfig, requireR2 } from './config.ts';
import { connectRedis } from './kv.ts';
import { log } from './log.ts';
import { createMailer } from './mailer.ts';
import { r2Sink } from './r2.ts';

const config = loadConfig();
const r2 = requireR2(config);
const kv = await connectRedis(config.redisUrl, (err) => log.error('redis', { err }));
const mailer = createMailer(config, log);
// Scans have their own budget, apart from what visitors ask for (budget.ts).
// One is ~45 requests at the package's default pace, 3 s apart.
const upstream = new PengePassportPH({
  stateDir: scanStateDir(config.stateDir),
  maxRequestsPerHour: SCAN_REQUESTS_PER_HOUR,
  maxWaitMs: 120_000,
  ...(config.publicBaseUrl ? { contact: config.publicBaseUrl } : {}),
});
// Posts abroad: their own budget and limiter, so they can never slow the scans at home.
const abroad = new PengePassportPH({
  stateDir: abroadStateDir(config.stateDir),
  maxRequestsPerHour: ABROAD_REQUESTS_PER_HOUR,
  maxWaitMs: 60_000,
  ...(config.publicBaseUrl ? { contact: config.publicBaseUrl } : {}),
});

try {
  const report = await runCheck({
    kv,
    upstream,
    abroad,
    sink: r2Sink({ ...r2, spoolDir: config.spoolDir, log }),
    mailer,
    keys: config.keys,
    log,
    publicBaseUrl: config.publicBaseUrl ?? 'http://localhost:8787',
    mailDailyLimit: config.mailDailyLimit,
    alertsPerSubscriberPerDay: config.alertsPerSubscriberPerDay,
    client: `${NAME}@${VERSION}`,
  });
  log.info('check finished', { ...report, mail: config.mailMode });
  process.exitCode = report.skipped || report.healthy ? 0 : 3;
} catch (err) {
  log.error('check crashed', { err: err as Error });
  process.exitCode = 1;
} finally {
  mailer.close();
  await kv.close().catch(() => {});
}
