// Turning push on in this browser: the permission first (inside the click),
// then a push-capable worker, then a subscription and a credential, both under
// the shared lock. Anything that fails turns the switch back off with a reason.
import { api } from '../api.ts';
import { ensureSubscribed, type PushEnv, type Post } from './shared.js';
import { readyWorker } from './worker.ts';

export const pushEnv = (): PushEnv => ({ indexedDB, locks: navigator.locks, crypto });
/** Sent on window when this browser's push state changes (the sheet, the confirmation page); the row listens. */
export const PUSH_CHANGED = 'pengepassportph-push-changed';
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

export const postToApi: Post = (path, body, method = 'POST') => {
  const b = body as { credential: string };
  if (method === 'DELETE') return api.pushOff(b.credential);
  return api.pushDevice(b);
};

export type EnableResult = { ok: true; credentialHash: string } | { ok: false; reason: 'denied' | 'dismissed' | 'no-worker' | 'subscribe-failed' };

export async function enablePush(a: { vapidPublicKey: string; timeoutMs?: number }): Promise<EnableResult> {
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  // Asked first, before any await, so the browser still sees the click.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
  const ready = await within(readyWorker(a.timeoutMs ?? 10_000), a.timeoutMs ?? 10_000);
  if (!ready) return { ok: false, reason: 'no-worker' };
  try {
    const { credentialHash } = await ensureSubscribed(pushEnv(), { registration: ready.registration, applicationServerKey: a.vapidPublicKey });
    return { ok: true, credentialHash };
  } catch {
    return { ok: false, reason: 'subscribe-failed' };
  }
}
