// Where the app runs (it only chooses wording), and whether push can work here.
// Detection is never a security check: the server checks everything again.
import type { StatusResponse } from '@penge/contracts';

export type Context = 'play' | 'installed' | 'browser';
const PLAY = 'com.alphaexperiments.pengepassportph';
const DEBUG = 'com.alphaexperiments.pengepassportph.dev';
const CONTEXT_KEY = 'pengepassportph-context';
const OWNER_KEY = 'pengepassportph-push-owner';

function remember(w: Window, key: string, value: string) {
  try {
    w.sessionStorage.setItem(key, value);
  } catch {
    // Private modes can refuse storage: detect again next time instead.
  }
}
function recall(w: Window, key: string): string | null {
  try {
    return w.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function detectContext(w: Window = window): Context {
  if (recall(w, CONTEXT_KEY) === 'play') return 'play';
  let pkg: string | null = null;
  try {
    const u = new URL(w.document.referrer);
    if (u.protocol === 'android-app:') pkg = u.hostname;
  } catch {
    // No referrer, or not a URL.
  }
  if (pkg === PLAY || (import.meta.env.VITE_LOCAL_DEBUG === '1' && pkg === DEBUG)) {
    remember(w, CONTEXT_KEY, 'play');
    return 'play';
  }
  if (['standalone', 'minimal-ui', 'fullscreen'].some((m) => w.matchMedia(`(display-mode: ${m})`).matches)) return 'installed';
  if ((w.navigator as Navigator & { standalone?: boolean }).standalone === true) return 'installed';
  return 'browser';
}

export function ownerOverride(w: Window = window): boolean {
  if (new URLSearchParams(w.location.search).get('push') === 'owner') remember(w, OWNER_KEY, '1');
  return recall(w, OWNER_KEY) === '1' || new URLSearchParams(w.location.search).get('push') === 'owner';
}

export type Capability = { ok: true } | { ok: false; reason: 'ios-tab' | 'unsupported' | 'off' | 'no-worker' };

export function pushCapability(w: Window, status: StatusResponse, o: { owner: boolean; workerOk: boolean }): Capability {
  if (status.push === 'off' || !status.vapidPublicKey || (status.push === 'owner' && !o.owner)) return { ok: false, reason: 'off' };
  const ua = w.navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in w.document);
  if (ios && detectContext(w) === 'browser') return { ok: false, reason: 'ios-tab' };
  const n = w.navigator as Navigator & { locks?: unknown };
  if (!w.isSecureContext || !('serviceWorker' in n) || !('PushManager' in w) || !('Notification' in w) || !n.locks) return { ok: false, reason: 'unsupported' };
  if (!o.workerOk) return { ok: false, reason: 'no-worker' };
  return { ok: true };
}

export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  if (!browser) return 'A browser';
  return os ? `${browser} on ${os}` : browser;
}
