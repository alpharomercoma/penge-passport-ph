import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSubscribed, keyBytes, markRequested, readState, reconcile, turnOff, withPushLock, writeState } from '../src/notify/shared.js';

/** Web Locks with one queue per name, like the browser's. */
function locks() {
  let tail: Promise<unknown> = Promise.resolve();
  return { request: (_name: string, fn: () => Promise<unknown>) => { const run = tail.then(fn); tail = run.then(() => undefined, () => undefined); return run; } } as unknown as LockManager;
}
let dbCount = 0;
// jsdom's crypto has no `subtle`: the tests use Node's Web Crypto, as browsers have.
const env = () => ({ indexedDB: new IDBFactory(), locks: locks(), crypto: webcrypto as unknown as Crypto, name: `t${dbCount++}` });

const P256 = `B${'A'.repeat(86)}`;
type FakeSub = { toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } }; unsubscribe: () => Promise<boolean> };
/** A browser's push manager: unsubscribing really drops the subscription. */
function registration(initialEndpoint: string | null, auth = 'AQEBAQEBAQEBAQEBAQEBAQ') {
  let current: FakeSub | null = null;
  const make = (endpoint: string, a = auth): FakeSub => {
    const s: FakeSub = { toJSON: () => ({ endpoint, keys: { p256dh: P256, auth: a } }), unsubscribe: vi.fn(async () => { if (current === s) current = null; return true; }) };
    return s;
  };
  if (initialEndpoint) current = make(initialEndpoint);
  return {
    make,
    set(s: FakeSub | null) { current = s; },
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => (current = make(`https://fcm.googleapis.com/new-${Math.random()}`))),
    },
  };
}

describe('shared push state', () => {
  let e: ReturnType<typeof env>;
  beforeEach(() => { e = env(); });

  it('keeps an existing credential and subscription when turned on again', async () => {
    const reg = registration('https://fcm.googleapis.com/a');
    const first = await ensureSubscribed(e, { registration: reg, applicationServerKey: P256 });
    const second = await ensureSubscribed(e, { registration: reg, applicationServerKey: P256 });
    expect(second.credentialHash).toBe(first.credentialHash);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('raises the revision when the subscription changes, keys included, and not otherwise', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, revision: 0, fingerprint: null, applicationServerKey: P256 });
    const reg = registration('https://fcm.googleapis.com/a');
    const post = vi.fn(async () => ({ state: 'registered' }));
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    expect((await readState(e)).revision).toBe(1);
    reg.set(reg.make('https://fcm.googleapis.com/a', 'AgICAgICAgICAgICAgICAg'));
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    expect((await readState(e)).revision).toBe(2);
    expect(post).toHaveBeenLastCalledWith('/api/push/device', expect.objectContaining({ revision: 2 }));
  });

  it('subscribes again when the browser dropped the subscription and permission is still granted', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, revision: 3, fingerprint: 'old', applicationServerKey: P256 });
    const reg = registration(null);
    const post = vi.fn(async () => ({ state: 'registered' }));
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/push/device', expect.objectContaining({ revision: 4 }));
  });

  it('takes a fresh endpoint once when the server says the endpoint is taken', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, revision: 1, fingerprint: null, applicationServerKey: P256 });
    const reg = registration('https://fcm.googleapis.com/copied');
    const post = vi.fn(async (_p: string, body: { subscription?: { endpoint: string } }) => ({ state: body.subscription?.endpoint.endsWith('copied') ? 'endpoint-taken' : 'registered' }));
    expect(await reconcile(e, { registration: reg, post, permission: 'granted' })).toEqual({ state: 'registered', subscribed: true });
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribes and registers in one call when the server says awaiting and this browser has no subscription', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null, applicationServerKey: P256 });
    const reg = registration(null);
    const post = vi.fn(async (_p: string, body: { subscription?: unknown }) => ({ state: body.subscription ? 'registered' : 'awaiting' }));
    expect(await reconcile(e, { registration: reg, post, permission: 'granted' })).toEqual({ state: 'registered', subscribed: true });
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('counts the 48 hours from the latest request', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, askedAt: 1, revision: 1, fingerprint: 'f', applicationServerKey: P256 });
    await markRequested(e);
    const st = await readState(e);
    expect(st.confirmed).toBe(false);
    expect(Date.now() - st.askedAt!).toBeLessThan(5000);
    expect(st.revision).toBe(1);
  });

  it('keeps an unconfirmed credential when the server says missing', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null, applicationServerKey: P256 });
    await reconcile(e, { registration: registration(null), post: async () => ({ state: 'missing' }), permission: 'default' });
    expect((await readState(e)).credential).toBe('c'.repeat(43));
  });

  it('does not let a slow turn-off in one tab wipe a fresh credential another tab made', async () => {
    await writeState(e, { credential: 'o'.repeat(43), confirmed: true, revision: 1, fingerprint: 'f', applicationServerKey: P256 });
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const slowPost = vi.fn(() => { entered(); return new Promise<{ ok: true; noChannel: false }>((r) => (release = () => r({ ok: true, noChannel: false }))); });
    const off = turnOff(e, { registration: registration('https://fcm.googleapis.com/a'), post: slowPost });
    await inside;
    let otherRan = false;
    const other = withPushLock(e, async () => { otherRan = true; await writeState(e, { credential: 'n'.repeat(43), confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null }); });
    await Promise.resolve();
    expect(otherRan).toBe(false); // the other tab waits for the lock
    release();
    expect(await off).toEqual({ ok: true, noChannel: false });
    await other;
    expect((await readState(e)).credential).toBe('n'.repeat(43));
  });

  it('does not let turning on in one tab and turning off in another leave a credential with no subscription', async () => {
    await writeState(e, { credential: 'o'.repeat(43), confirmed: true, revision: 1, fingerprint: 'f', applicationServerKey: P256 });
    const reg = registration('https://fcm.googleapis.com/a');
    const post = vi.fn(async () => ({ ok: true, noChannel: false }));
    // The lock runs them one after the other: off first (it asked first), then on again.
    await Promise.all([turnOff(e, { registration: reg, post }), ensureSubscribed(e, { registration: reg, applicationServerKey: P256 })]);
    const state = await readState(e);
    expect(state.credential).not.toBeNull();
    expect(state.credential).not.toBe('o'.repeat(43)); // a fresh credential: the old one was turned off
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1); // a fresh subscription: the old one was dropped
    expect(await reg.pushManager.getSubscription()).not.toBeNull();
  });

  it('replaces a subscription made with another server key, keeping the credential', async () => {
    const OLD = `B${'B'.repeat(86)}`;
    const reg = registration('https://fcm.googleapis.com/a');
    const first = await ensureSubscribed(e, { registration: reg, applicationServerKey: OLD });
    const old = (await reg.pushManager.getSubscription())!;
    Object.assign(old, { options: { applicationServerKey: keyBytes(OLD).buffer } });
    const second = await ensureSubscribed(e, { registration: reg, applicationServerKey: P256 });
    expect(second.credentialHash).toBe(first.credentialHash);
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect((await readState(e)).applicationServerKey).toBe(P256);
  });

  it('fails a write whose transaction aborts, so the lock is never held for good', async () => {
    // A store whose commit fails (a full disk): the requests succeed, then the transaction aborts.
    const tx: Record<string, ((...a: unknown[]) => void) | null> & { objectStore?: unknown } = { oncomplete: null, onerror: null, onabort: null };
    tx.objectStore = () => ({
      get: () => {
        const req: { result: undefined; onsuccess: (() => void) | null } = { result: undefined, onsuccess: null };
        setTimeout(() => { req.onsuccess?.(); setTimeout(() => tx.onabort?.()); });
        return req;
      },
      put: () => ({}),
    });
    const db = { transaction: () => tx, close: vi.fn() };
    const indexedDB = { open: () => { const req: Record<string, unknown> = { result: db }; setTimeout(() => (req.onsuccess as () => void)()); return req; } } as unknown as IDBFactory;
    await expect(writeState({ ...e, indexedDB }, { confirmed: true })).rejects.toBeTruthy();
  });
});
