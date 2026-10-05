import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS } from './helpers.tsx';

const workerMock = vi.hoisted(() => ({ ready: vi.fn(), failed: vi.fn(() => false) }));
vi.mock('../src/notify/worker.ts', () => ({
  register: vi.fn(),
  registration: vi.fn(async () => null),
  workerFailed: workerMock.failed,
  readyWorker: workerMock.ready,
}));
const sharedMock = vi.hoisted(() => ({ ensureSubscribed: vi.fn() }));
vi.mock('../src/notify/shared.js', async (orig) => ({ ...(await orig<object>()), ensureSubscribed: sharedMock.ensureSubscribed }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectContext, deviceLabel, ownerOverride, pushCapability } from '../src/notify/context.ts';
import { enablePush } from '../src/notify/push.ts';
import { builtWorkerSource } from './worker-source.ts';

const LIVE = { ...STATUS, push: 'live' as const, vapidPublicKey: 'B'.repeat(87) };

/** A Storage that keeps what it is given, like the browser's. */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
function fakeWindow(over: Record<string, unknown> = {}, storage = new MemoryStorage()) {
  return {
    document: { referrer: '' },
    matchMedia: (q: string) => ({ matches: false, media: q }),
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile', serviceWorker: {}, locks: {} },
    PushManager: function () {},
    Notification: { permission: 'default' },
    isSecureContext: true,
    sessionStorage: storage,
    location: { search: '' },
    ...over,
  } as unknown as Window;
}

afterEach(() => {
  vi.unstubAllGlobals();
  workerMock.ready.mockReset();
  sharedMock.ensureSubscribed.mockReset();
});

describe('where the app runs', () => {
  it('knows the Play app by its exact package, and remembers it', () => {
    const storage = new MemoryStorage();
    expect(detectContext(fakeWindow({ document: { referrer: 'android-app://com.alphaexperiments.pengepassportph/' } }, storage))).toBe('play');
    expect(detectContext(fakeWindow({}, storage))).toBe('play'); // the referrer is gone after the first page
    expect(detectContext(fakeWindow({ document: { referrer: 'android-app://com.alphaexperiments.pengepassportph.evil/' } }))).toBe('browser');
    expect(detectContext(fakeWindow({ document: { referrer: 'android-app://com.alphaexperiments.pengepassportph/https/alphaexperiments.com/pengepassportph/' } }))).toBe('play');
  });

  it('knows an installed app by its display mode', () => {
    for (const mode of ['standalone', 'minimal-ui', 'fullscreen']) {
      expect(detectContext(fakeWindow({ matchMedia: (q: string) => ({ matches: q.includes(mode) }) }))).toBe('installed');
    }
  });

  it('offers nothing in an iPhone tab, whatever the APIs say', () => {
    const iphone = fakeWindow({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605', serviceWorker: {}, locks: {} } });
    expect(pushCapability(iphone, LIVE, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'ios-tab' });
  });

  it('hides push when the server has it off, and in owner mode unless ?push=owner, which it remembers', () => {
    expect(pushCapability(fakeWindow(), { ...LIVE, push: 'off' }, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'off' });
    expect(pushCapability(fakeWindow(), { ...LIVE, push: 'owner' }, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'off' });
    expect(pushCapability(fakeWindow(), { ...LIVE, push: 'owner' }, { owner: true, workerOk: true })).toEqual({ ok: true });
    const storage = new MemoryStorage();
    expect(ownerOverride(fakeWindow({ location: { search: '?push=owner' } }, storage))).toBe(true);
    expect(ownerOverride(fakeWindow({ location: { search: '' } }, storage))).toBe(true);
    expect(ownerOverride(fakeWindow({ location: { search: '' } }))).toBe(false);
  });

  it('treats a browser without Web Locks, or whose worker failed to register, as not capable', () => {
    expect(pushCapability(fakeWindow({ navigator: { userAgent: 'x', serviceWorker: {} } }), LIVE, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'unsupported' });
    expect(pushCapability(fakeWindow(), LIVE, { owner: false, workerOk: false })).toEqual({ ok: false, reason: 'no-worker' });
  });

  it('labels a device coarsely', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Gecko/20100101 Firefox/143.0')).toBe('Firefox on Mac');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile')).toBe('Chrome on Android');
    expect(deviceLabel('<script>')).toBe('A browser');
  });
});

describe('turning push on', () => {
  beforeEach(() => vi.stubGlobal('navigator', { ...navigator, locks: { request: (_: string, fn: () => unknown) => fn() } }));

  it('waits for the new worker when the real old one (from the last release) is active', async () => {
    // A fresh copy of the module: its registration state is set once per page load.
    vi.resetModules();
    const { readyWorker: realReady, register } = await vi.importActual<typeof import('../src/notify/worker.ts')>('../src/notify/worker.ts');
    // A worker built from a source: postMessage reaches its 'message' listeners, if it has any.
    const workerFrom = (source: string) => {
      const listeners: Record<string, ((e: unknown) => void)[]> = {};
      const self = { registration: { scope: 'https://x/' }, location: new URL('https://x/sw.js'), addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f), skipWaiting: () => {}, clients: { claim: () => {} } };
      new Function('self', 'caches', 'fetch', 'Response', source)(self, {}, () => {}, Response);
      return { postMessage: (data: unknown, ports: MessagePort[]) => listeners.message?.forEach((f) => f({ data, ports })) } as unknown as ServiceWorker;
    };
    const oldSource = readFileSync(join(__dirname, 'fixtures/v0.2/sw.js'), 'utf8').replace('__VERSION__', 'old').replace('__SHELL__', '[]');
    const newSource = builtWorkerSource();
    const swListeners: Record<string, () => void> = {};
    const reg = { active: workerFrom(oldSource), update: vi.fn(async () => { reg.active = workerFrom(newSource); swListeners.controllerchange?.(); }) };
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), addEventListener: (t: string, f: () => void) => (swListeners[t] = f), removeEventListener: () => {} },
    });
    register();
    expect(await realReady()).toEqual({ registration: reg });
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it("notices a new worker that took over during the old one's silent handshake", async () => {
    vi.resetModules();
    const { readyWorker: realReady, register } = await vi.importActual<typeof import('../src/notify/worker.ts')>('../src/notify/worker.ts');
    const swListeners: Record<string, () => void> = {};
    const newWorker = { postMessage: (_d: unknown, ports: MessagePort[]) => ports[0]!.postMessage({ push: true }) } as unknown as ServiceWorker;
    const reg: { active: ServiceWorker; update: ReturnType<typeof vi.fn> } = {
      // The old worker never answers; while it is being asked, the browser swaps in the new one.
      active: { postMessage: () => { setTimeout(() => { reg.active = newWorker; swListeners.controllerchange?.(); }, 10); } } as unknown as ServiceWorker,
      update: vi.fn(async () => {}), // finds nothing newer: no further event
    };
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), addEventListener: (t: string, f: () => void) => (swListeners[t] = f), removeEventListener: () => {} },
    });
    register();
    expect(await realReady()).toEqual({ registration: reg });
  });

  it('notices a takeover even while its own update request is still fetching', async () => {
    vi.resetModules();
    const { readyWorker: realReady, register } = await vi.importActual<typeof import('../src/notify/worker.ts')>('../src/notify/worker.ts');
    const swListeners: Record<string, () => void> = {};
    const newWorker = { postMessage: (_d: unknown, ports: MessagePort[]) => ports[0]!.postMessage({ push: true }) } as unknown as ServiceWorker;
    const reg: { active: ServiceWorker; update: ReturnType<typeof vi.fn> } = {
      active: { postMessage: () => {} } as unknown as ServiceWorker, // the old worker: silent
      // Its fetch of sw.js stalls; meanwhile the install that was already under way finishes.
      update: vi.fn(() => {
        setTimeout(() => {
          reg.active = newWorker;
          swListeners.controllerchange?.();
        }, 50);
        return new Promise(() => {});
      }),
    };
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), addEventListener: (t: string, f: () => void) => (swListeners[t] = f), removeEventListener: () => {} },
    });
    register();
    expect(await realReady(5000)).toEqual({ registration: reg });
  });

  it('stops waiting at its deadline and leaves no listener behind', async () => {
    vi.resetModules();
    const { readyWorker: realReady, register } = await vi.importActual<typeof import('../src/notify/worker.ts')>('../src/notify/worker.ts');
    const removed = vi.fn();
    const reg = { active: { postMessage: () => {} } as unknown as ServiceWorker, update: vi.fn(async () => { throw new Error('offline'); }) };
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), addEventListener: () => {}, removeEventListener: removed },
    });
    register();
    expect(await realReady(1500)).toBeNull();
    expect(removed).toHaveBeenCalledWith('controllerchange', expect.any(Function));
  }, 4000);

  it('gives a hint without asking when permission was already denied (Review Focus 2)', async () => {
    const request = vi.fn();
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: request });
    expect(await enablePush({ vapidPublicKey: LIVE.vapidPublicKey })).toEqual({ ok: false, reason: 'denied' });
    expect(request).not.toHaveBeenCalled();
  });

  it('turns back off when subscribe() is refused (Review Focus 3)', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });
    workerMock.ready.mockResolvedValue({ registration: {} });
    sharedMock.ensureSubscribed.mockRejectedValue(new DOMException('no', 'AbortError'));
    expect(await enablePush({ vapidPublicKey: LIVE.vapidPublicKey })).toEqual({ ok: false, reason: 'subscribe-failed' });
  });

  it('gives up after 10 s when no push-capable worker takes over', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });
    workerMock.ready.mockReturnValue(new Promise(() => {}));
    const result = enablePush({ vapidPublicKey: LIVE.vapidPublicKey });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ ok: false, reason: 'no-worker' });
    vi.useRealTimers();
  });

  it('passes a channel error from the server to the form', async () => {
    const { api, ApiFailure } = await vi.importActual<typeof import('../src/api.ts')>('../src/api.ts');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Please fix the highlighted fields.', fields: { channels: 'Notifications are not available yet.' } }), { status: 400 })));
    const err = await api.subscribe({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: null, website: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as InstanceType<typeof ApiFailure>).fields.channels).toBe('Notifications are not available yet.');
  });

  it('returns the credential hash once subscribed', async () => {
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
    workerMock.ready.mockResolvedValue({ registration: {} });
    sharedMock.ensureSubscribed.mockResolvedValue({ credentialHash: 'h'.repeat(43) });
    expect(await enablePush({ vapidPublicKey: LIVE.vapidPublicKey })).toEqual({ ok: true, credentialHash: 'h'.repeat(43) });
  });
});
