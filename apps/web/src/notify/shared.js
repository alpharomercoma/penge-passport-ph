// Push state shared by the page and the service worker: one IndexedDB store and
// one Web Lock, so the two never act on a subscription the other has changed.
// Plain JavaScript: sw-plugin.ts inlines this file into sw.js. Types: shared.d.ts.
export const LOCK_NAME = 'pengepassportph-push';
const DB = 'pengepassportph-push';
const STORE = 'state';
const KEY = 'device';
const UNCONFIRMED_MS = 48 * 3600 * 1000;

const empty = () => ({ credential: null, confirmed: false, askedAt: null, revision: 0, fingerprint: null, applicationServerKey: null });

function open(env) {
  return new Promise((resolve, reject) => {
    const req = env.indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs one transaction; settles on complete, error or abort (a full disk aborts a commit with no request error). */
function inTransaction(env, mode, use) {
  return open(env).then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        let value;
        use(tx.objectStore(STORE), (v) => (value = v));
        const fail = () => {
          db.close?.();
          reject(tx.error ?? new DOMException('The push state could not be saved.', 'AbortError'));
        };
        tx.oncomplete = () => {
          db.close?.();
          resolve(value);
        };
        tx.onerror = fail;
        tx.onabort = fail;
      }),
  );
}

export function readState(env) {
  return inTransaction(env, 'readonly', (store, done) => {
    const req = store.get(KEY);
    req.onsuccess = () => done({ ...empty(), ...(req.result ?? {}) });
  });
}

export function writeState(env, patch) {
  return inTransaction(env, 'readwrite', (store) => {
    const get = store.get(KEY);
    get.onsuccess = () => store.put({ ...empty(), ...(get.result ?? {}), ...patch }, KEY);
  }).then(() => undefined);
}

export const withPushLock = (env, fn) => env.locks.request(LOCK_NAME, fn);

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sha256 = async (env, text) => b64url(await env.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const fingerprint = (env, json) => sha256(env, `${json.endpoint}\n${json.keys?.p256dh}\n${json.keys?.auth}`);
export const newCredential = (env) => b64url(env.crypto.getRandomValues(new Uint8Array(32)));
export const credentialHash = (env, c) => sha256(env, c);

/** Turn push on in this browser: keep what exists, make what is missing. */
export function ensureSubscribed(env, { registration, applicationServerKey }) {
  return withPushLock(env, async () => {
    const state = await readState(env);
    const credential = state.credential ?? newCredential(env);
    const wanted = keyBytes(applicationServerKey);
    let current = await registration.pushManager.getSubscription();
    // Made with another server key (the server's was replaced): pushes signed with the new one
    // would never reach it, so it is replaced. The credential stays; the next reconcile registers it.
    const had = current?.options?.applicationServerKey;
    if (current && had && !sameBytes(new Uint8Array(had), wanted)) {
      await current.unsubscribe();
      current = null;
    }
    if (!current) await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
    await writeState(env, {
      credential,
      applicationServerKey,
      ...(state.credential ? {} : { confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null }),
    });
    return { credentialHash: await credentialHash(env, credential) };
  });
}

/** Bring the server in line with this browser's subscription. Null when this browser has no credential. */
export function reconcile(env, { registration, post, permission }) {
  return withPushLock(env, async () => {
    let state = await readState(env);
    if (!state.credential) return null;
    let freshEndpoint = false;
    let serverKnows = state.confirmed;
    for (let attempt = 0; attempt < 4; attempt++) {
      let current = await registration.pushManager.getSubscription();
      if (!current && permission === 'granted' && state.applicationServerKey && serverKnows) {
        current = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.applicationServerKey) });
      }
      const json = current ? current.toJSON() : null;
      let body = { credential: state.credential };
      if (json?.endpoint) {
        const fp = await fingerprint(env, json);
        if (fp !== state.fingerprint) {
          state = { ...state, revision: state.revision + 1, fingerprint: fp };
          await writeState(env, { revision: state.revision, fingerprint: fp });
        }
        body = { ...body, subscription: json, revision: state.revision };
      }
      const answer = await post('/api/push/device', body);
      if (answer.state === 'stale') continue;
      // Someone else holds this endpoint (a copied subscription): take a fresh one, once.
      if (answer.state === 'endpoint-taken' && current && state.applicationServerKey && !freshEndpoint) {
        freshEndpoint = true;
        await current.unsubscribe();
        await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.applicationServerKey) });
        continue;
      }
      if (answer.state === 'registered' || answer.state === 'awaiting') await writeState(env, { confirmed: true });
      // Confirmed elsewhere, and this browser has no subscription to register yet: make one now, in this same call.
      if (answer.state === 'awaiting' && !current && permission === 'granted' && state.applicationServerKey && !serverKnows) {
        serverKnows = true;
        continue;
      }
      if (answer.state === 'missing') {
        const young = !state.confirmed && state.askedAt !== null && Date.now() - state.askedAt < UNCONFIRMED_MS;
        if (!young) {
          await current?.unsubscribe();
          await writeState(env, empty());
        }
      }
      // What this browser has, as well as what the server says: "on" needs both.
      return { state: answer.state, subscribed: !!current };
    }
    return { state: 'stale', subscribed: false };
  });
}

/** After a sign-up request with push on: the 48-hour protection counts from this request, not from the credential's birth. */
export function markRequested(env) {
  return withPushLock(env, () => writeState(env, { confirmed: false, askedAt: Date.now() }));
}

/** Turn this device off: on the server, in the browser, and here, unless another tab made a new credential meanwhile. */
export function turnOff(env, { registration, post }) {
  return withPushLock(env, async () => {
    const state = await readState(env);
    if (!state.credential) return null;
    const answer = await post('/api/push/device', { credential: state.credential }, 'DELETE');
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    const now = await readState(env);
    if (now.credential === state.credential) await writeState(env, empty());
    return answer;
  });
}
