// The real browser behind the controller: the push manager of the active registration, the worker handshake,
// notifications on screen, visibility and the driver lock.
import * as S from './state.js';
import type { Browser, BrowserSub } from './controller.ts';
import { readyWorker } from '../notify/worker.ts';

const wrap = (s: PushSubscription): BrowserSub => {
  const j = s.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return { json: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }, unsubscribe: () => s.unsubscribe() };
};
const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function realBrowser(): Browser {
  const reg = async () => (await readyWorker(10_000))?.registration ?? null;
  return {
    permission: () => ('Notification' in window ? Notification.permission : 'denied'),
    // Null only when the push manager itself says there is none; no registration reached is an error (unknown).
    subscription: async () => {
      const r = await reg();
      if (!r) throw new S.Unsupported('no service worker registration');
      const s = await r.pushManager.getSubscription();
      return s ? wrap(s) : null;
    },
    subscribe: async (vapid) => {
      const r = await reg();
      if (!r) throw new S.Unsupported('no service worker');
      return wrap(await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapid) }));
    },
    workerReady: async () => (await readyWorker(10_000)) !== null,
    workerReads: async (op) => {
      const r = await reg();
      const worker = r?.active;
      if (!worker) return false;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(false), 3000);
        channel.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve((e.data as { op?: string } | null)?.op === op);
        };
        worker.postMessage({ type: 'read-operation' }, [channel.port2]);
      });
    },
    closeNotifications: async () => {
      const r = await reg();
      for (const n of (await r?.getNotifications()) ?? []) n.close();
    },
    drive: async (fn) => {
      if (!navigator.locks) return fn();
      return navigator.locks.request(S.DRIVER_LOCK, { ifAvailable: true }, async (lock) => (lock ? fn() : null));
    },
    visible: () => document.visibilityState === 'visible',
  };
}

export const browserEnv = (): S.Env => ({ indexedDB: window.indexedDB, locks: navigator.locks, crypto: window.crypto });
