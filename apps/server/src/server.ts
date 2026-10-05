// The API process: `node dist/server.mjs`, kept running by systemd.
import { serve } from '@hono/node-server';
import { PengePassportPH } from 'penge-passport-ph';
import { createApi } from './api.ts';
import { LOOKUP_REQUESTS_PER_HOUR, lookupStateDir } from './budget.ts';
import { loadConfig } from './config.ts';
import { connectRedis } from './kv.ts';
import { log } from './log.ts';
import { createLookups } from './lookups.ts';
import { createMailer } from './mailer.ts';
import { createStats } from './stats.ts';

const config = loadConfig();
const kv = await connectRedis(config.redisUrl, (err) => log.error('redis', { err }));
const mailer = createMailer(config, log);
// What visitors ask for has its own budget, apart from the scans (budget.ts);
// a visitor never waits more than 15 s in its queue.
const upstream = new PengePassportPH({
  stateDir: lookupStateDir(config.stateDir),
  maxRequestsPerHour: LOOKUP_REQUESTS_PER_HOUR,
  maxWaitMs: 15_000,
  ...(config.publicBaseUrl ? { contact: config.publicBaseUrl } : {}),
});
const lookups = createLookups({ kv, upstream, log });
const app = createApi({
  lookups,
  kv,
  keys: config.keys,
  mailer,
  log,
  publicBaseUrl: config.publicBaseUrl ?? `http://localhost:${config.api.port}`,
  stats: createStats(kv, log),
  push: config.push,
});

const server = serve({ fetch: app.fetch, hostname: config.api.host, port: config.api.port }, (info) =>
  log.info('api listening', { host: info.address, port: info.port, mail: config.mailMode }),
);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info('api stopping', { signal });
    server.close(() => {
      mailer.close();
      void kv.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
