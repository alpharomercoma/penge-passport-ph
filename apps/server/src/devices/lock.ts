// The checker's lock (pp:lock:check), taken with SET NX and renewed and released only by its owner, atomically
// (the release before push checked, then set: a gap another run could fall into). A heartbeat renews it while
// slow sends run, so a run never outlives it unknowingly; every delivery script checks the owner anyway.
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { deviceScript } from './lua.ts';

const renewScript = deviceScript(
  'lock-renew',
  `need(KEY.lock, 'string')
if redis.call('GET', KEY.lock) ~= A.run then return 'false' end
redis.call('EXPIRE', KEY.lock, A.ttl)
return 'true'`,
  { reclaim: true },
);

const releaseScript = deviceScript(
  'lock-release',
  `need(KEY.lock, 'string')
if redis.call('GET', KEY.lock) == A.run then redis.call('DEL', KEY.lock) end
return 'true'`,
  { reclaim: true },
);

/** A "cleanup-…" run (admin.mjs device-cleanup) takes its own lock; the scripts' prelude fences it by that one too. */
export const lockKeyFor = (run: string) => (run.startsWith('cleanup-') ? K.devCleanupLock : K.checkLock);
export const acquireLock = (kv: Kv, run: string, ttlSeconds: number) => kv.set(lockKeyFor(run), run, { nx: true, ttlSeconds });
export const renewLock = (kv: Kv, run: string, ttlSeconds: number) => renewScript.run<boolean>(kv, {}, { now: 0, run, ttl: ttlSeconds });
export const releaseLock = async (kv: Kv, run: string) => void (await releaseScript.run(kv, {}, { now: 0, run }));

export function heartbeat(kv: Kv, run: string, ttlSeconds: number, everyMs = 60_000) {
  let lost = false;
  const timer = setInterval(() => {
    renewLock(kv, run, ttlSeconds)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => {});
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer), lost: () => lost };
}
