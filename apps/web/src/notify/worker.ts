// The service worker this page registers, and a check that the active one can
// handle pushes. An old worker has no message handler and never answers: silence
// means old, so the page asks for the new one and waits for it to take over.
import { BASE } from '../links.ts';

let failed = false;
let settle!: (r: ServiceWorkerRegistration | null) => void;
/** Resolves once registration has finished (or was skipped): anyone may wait on it from the start. */
const done = new Promise<ServiceWorkerRegistration | null>((r) => (settle = r));

export function register(): void {
  if (!('serviceWorker' in navigator)) return settle(null);
  navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).then(settle, () => {
    failed = true;
    settle(null);
  });
}
/** Development builds register no worker. */
export const skipRegistration = () => settle(null);
export const registration = () => done;
export const workerFailed = () => failed;

function ask(worker: ServiceWorker, ms: number): Promise<{ push?: boolean } | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (answer: { push?: boolean } | null) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), ms);
    channel.port1.onmessage = (e) => finish(e.data as { push?: boolean });
    worker.postMessage({ type: 'capabilities' }, [channel.port2]);
  });
}

/**
 * A registration whose active worker handles pushes, or null within `timeoutMs`. Every wait
 * (registration, readiness, the handshake, a takeover) races the same deadline, and expiry
 * always leaves through the clean-up, so a timed-out call leaves nothing listening.
 */
export async function readyWorker(timeoutMs = 10_000): Promise<{ registration: ServiceWorkerRegistration } | null> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((r) => {
    timer = setTimeout(() => {
      expired = true;
      r(null);
    }, timeoutMs);
  });
  const until = <T>(p: Promise<T>) => Promise.race([p, deadline]);
  // Listening from the start: the browser's own update can swap the worker in at any moment,
  // the handshake's second included, and that change must not be missed.
  let wake = () => {};
  const onChange = () => wake();
  let listening = false;
  try {
    const reg = await until(done);
    if (!reg || expired) return null;
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    listening = true;
    let updated = false;
    while (!expired) {
      const active = reg.active ?? (await until(navigator.serviceWorker.ready))?.active ?? null;
      if (expired) return null;
      if (active && (await until(ask(active, 1000)))?.push) return { registration: reg };
      if (expired) return null;
      // Swapped while we asked: ask the new one.
      if (reg.active && reg.active !== active) continue;
      const swapped = new Promise<void>((r) => (wake = r));
      // Asked for once, never waited on: a slow fetch of sw.js must not hide a takeover meanwhile.
      if (!updated) {
        updated = true;
        void reg.update().catch(() => undefined);
      }
      if (reg.active === active) await until(swapped);
    }
    return null;
  } finally {
    clearTimeout(timer);
    if (listening) navigator.serviceWorker.removeEventListener('controllerchange', onChange);
  }
}
