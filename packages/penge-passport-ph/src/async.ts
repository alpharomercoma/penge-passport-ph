/** Node's timers hold at most 2^31 - 1 ms; longer delays silently become 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Sleep for `ms`, however long, in timer-sized steps. NaN or negative sleeps no time. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  let remaining = ms > 0 ? ms : 0;
  do {
    const step = Math.min(remaining, MAX_TIMER_MS);
    await sleepOnce(step, signal);
    remaining -= step;
  } while (remaining > 0);
}

function sleepOnce(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wait for `promise`, but give up (without cancelling it) when `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // This caller will not see how `promise` ends; its failure must not go unhandled.
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
