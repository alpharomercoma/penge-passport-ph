// This device's notification alert: one IndexedDB record and one Web Lock, shared by the page and the service worker
// (spec: "Browser state"). Every change is one short read-check-write under the lock; the lock is never held across a
// network call or a wait for a push. Plain JavaScript: sw-plugin.ts inlines this file into sw.js. Types: state.d.ts.
export const DB_NAME = 'pengepassportph-device-alerts';
export const LOCK_NAME = 'pengepassportph-device-alerts';
export const DRIVER_LOCK = 'pengepassportph-device-alerts-driver';
export const LEGACY_DB = 'pengepassportph-push';
export const UNKNOWN_SUBSCRIPTION = '?';
const STORE = 'state';
const KEY = 'device';
const UNANSWERED_MS = 2 * 60_000;
const AFTER_EXPIRY_MS = 30_000;

export class Unsupported extends Error {
  constructor(message) {
    super(message);
    this.name = 'Unsupported';
  }
}

const empty = () => ({ credential: null, seq: 0, epoch: 0, op: null, needsRotation: false, claim: null, retired: [], vapidKey: null, known: null, renewedAt: null, gone: [], choices: null, knownVersion: 0 });

function open(env, name = DB_NAME) {
  if (!env.indexedDB) return Promise.reject(new Unsupported('no IndexedDB'));
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = env.indexedDB.open(name, 1);
    } catch {
      reject(new Unsupported('IndexedDB refused'));
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Unsupported('IndexedDB failed'));
    req.onblocked = () => reject(new Unsupported('IndexedDB blocked'));
  });
}

/** One transaction; settles on complete, error or abort (a full disk aborts a commit with no request error). */
function transact(env, mode, use, name) {
  return open(env, name).then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        let value;
        use(tx.objectStore(STORE), (v) => (value = v));
        const fail = () => {
          db.close?.();
          reject(new Unsupported('IndexedDB could not save'));
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
  return transact(env, 'readonly', (store, done) => {
    const req = store.get(KEY);
    req.onsuccess = () => done({ ...empty(), ...(req.result ?? {}) });
  });
}


function withLock(env, fn) {
  if (!env.locks?.request) return Promise.reject(new Unsupported('no Web Locks'));
  return env.locks.request(LOCK_NAME, fn);
}

/**
 * Read, decide, write, in one readwrite transaction under the lock: `fn` (synchronous) returns the new state (or none)
 * and a result, which is given once the transaction has committed. Nothing (a database deletion either) can come
 * between the read and the write.
 */
export function update(env, fn) {
  return withLock(env, () => {
    let failure = null;
    return transact(env, 'readwrite', (store, done) => {
      const req = store.get(KEY);
      req.onsuccess = () => {
        try {
          const { state, result } = fn({ ...empty(), ...(req.result ?? {}) });
          if (state) store.put(state, KEY);
          done(result);
        } catch (err) {
          failure = err;
          req.transaction.abort();
        }
      };
    }).catch((err) => {
      throw failure ?? err;
    });
  });
}

export function opDone(op, now) {
  if (op.result) return true;
  if (op.expiresAt) return now > op.expiresAt + AFTER_EXPIRY_MS;
  return now > op.createdAt + UNANSWERED_MS;
}

const same = (op, kind, choices, captured) => op.kind === kind && JSON.stringify(op.choices) === JSON.stringify(choices) && JSON.stringify(op.captured) === JSON.stringify(captured);

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const newCredential = (env) => b64url(env.crypto.getRandomValues(new Uint8Array(32)));
export const newId = (env) => b64url(env.crypto.getRandomValues(new Uint8Array(16)));
const sha256 = async (env, text) => b64url(await env.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
export const credentialHash = (env, credential) => sha256(env, credential);

/** The subscription as page and server hash it: endpoint and unpadded keys, in this order (contracts' canonicalSubscription). */
export function canonical(json) {
  return JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh.replace(/=+$/, ''), auth: json.keys.auth.replace(/=+$/, '') } });
}
export const fingerprint = (env, json) => sha256(env, canonical(json));

export function begin(env, { kind, choices, captured, now }) {
  return update(env, (s) => {
    if (s.claim) return { result: { blocked: 'claim' } };
    // A turned-off credential's alert must be confirmed deleted on the server before anything new starts.
    if (s.retired.some((r) => !r.deleted)) return { result: { blocked: 'retired' } };
    if (s.op && !opDone(s.op, now)) {
      if (same(s.op, kind, choices, captured)) return { result: { joined: s.op } };
      return { result: { waiting: s.op } };
    }
    const credential = s.credential ?? newCredential(env);
    const op = { op: newId(env), seq: s.seq + 1, epoch: s.epoch, kind, phase: 'preparing', choices, captured, subscription: null, fingerprint: null, nonce: null, expiresAt: null, createdAt: now, result: null, activation: null, by: null };
    // The last choices asked for, so a first setup whose subscription changed before it finished can start again.
    return { state: { ...s, credential, seq: op.seq, op, choices: choices ?? s.choices }, result: { started: op, credential } };
  });
}

/**
 * The subscription for a `preparing` operation, compare-and-set: only the first page to attach one does ('ok'); a
 * request already prepared is never changed ('already': use the stored one); a dropped or newer one, 'abandoned'.
 */
export function attach(env, { op, epoch, subscription, fingerprint: fp, by }) {
  return update(env, (s) => {
    if (!s.op || s.op.op !== op || s.epoch !== epoch || s.op.result) return { result: 'abandoned' };
    if (s.op.phase !== 'preparing') return { result: 'already' };
    // An unsubscribe claim stands: its subscription is about to be removed, so nothing is attached until it is resolved
    // (begin() then starts a fresh operation).
    if (s.claim) return { result: 'abandoned' };
    return { state: { ...s, op: { ...s.op, phase: 'attached', subscription, fingerprint: fp, by } }, result: 'ok' };
  });
}

export function confirmReady(env, { op, by }) {
  return update(env, (s) => {
    if (!s.op || s.op.op !== op || s.op.phase !== 'attached' || s.op.by !== by || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, phase: 'ready' } }, result: true };
  });
}

/**
 * Drops the operation if it is still preparing, or if `by` attached it (never another caller's attached request); returns
 * an unsubscribe claim for `fingerprint` only if nothing the device knows uses it.
 */
export function abandon(env, { op, fingerprint: fp, by }) {
  return update(env, (s) => {
    const mine = s.op?.op === op && !s.op.result && (s.op.phase === 'preparing' || (s.op.phase === 'attached' && by !== null && s.op.by === by));
    const next = { ...s, op: mine ? null : s.op };
    const used = !fp || next.op?.fingerprint === fp || s.known?.fingerprint === fp || !!s.claim;
    if (used) return { state: next, result: null };
    const claim = { task: newId(env), fingerprint: fp };
    return { state: { ...next, claim }, result: claim };
  });
}

export function markSent(env, { op, expiresAt }) {
  return update(env, (s) => {
    // Only a request that was ready to send (its subscription attached, its handshake done), and is unfinished.
    if (!s.op || s.op.op !== op || s.op.result || (s.op.phase !== 'ready' && s.op.phase !== 'sent') || !s.op.subscription || !s.op.fingerprint) return { result: false };
    return { state: { ...s, op: { ...s.op, phase: 'sent', expiresAt: expiresAt ?? s.op.expiresAt } }, result: true };
  });
}

export function storeNonce(env, { op, credential, fingerprint: fp, nonce }) {
  return update(env, (s) => {
    if (s.credential !== credential || !s.op || s.op.op !== op || s.op.fingerprint !== fp || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, nonce } }, result: true };
  });
}

export function recordResult(env, { op, credential, result, activation }) {
  return update(env, (s) => {
    if (s.credential !== credential || !s.op || s.op.op !== op || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, result, activation } }, result: true };
  });
}

/** Drops an operation that has a result, or is still preparing (nothing attached); never another caller's attached request. */
export function finish(env, { op }) {
  return update(env, (s) => (s.op?.op === op && (s.op.result || s.op.phase === 'preparing') ? { state: { ...s, op: null }, result: undefined } : { result: undefined }));
}

/** Known alert for this credential; an older generation or revision of the same incarnation never replaces a newer one. */
export function setKnown(env, { credential, known, version }) {
  return update(env, (s) => {
    if (s.credential !== credential) return { result: false };
    if (version !== undefined && s.knownVersion !== version) return { result: false };
    const k = s.known;
    if (known && k && known.incarnation === k.incarnation && (known.generation < k.generation || (known.generation === k.generation && known.revision < k.revision))) return { result: false };
    return { state: { ...s, known, knownVersion: s.knownVersion + 1 }, result: true };
  });
}

export function setEndsAt(env, { credential, alertId, incarnation, generation, endsAt }) {
  return update(env, (s) => {
    const k = s.known;
    if (s.credential !== credential || !k || k.alertId !== alertId || k.incarnation !== incarnation || k.generation !== generation) return { result: null };
    const next = { ...k, endsAt: Math.max(k.endsAt, endsAt) };
    return { state: { ...s, known: next, knownVersion: s.knownVersion + 1 }, result: next };
  });
}

export function adopt(env, { op, from, by }) {
  return update(env, (s) => {
    if (!s.op || s.op.op !== op || s.op.phase !== 'attached' || s.op.by !== from || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, by } }, result: true };
  });
}

/** Turn off, in one step: a new epoch, the credential retired, the unsubscribe claim written, the operation dropped. */
// `fingerprint`: the browser's subscription, null when it has none, UNKNOWN_SUBSCRIPTION when it could not be asked (a
// claim for whatever subscription is found once it can be).
export function turnOff(env, { fingerprint: fp }) {
  return update(env, (s) => {
    // An earlier claim is kept: resolving it meets the browser's one subscription (replacing the claim when it differs),
    // and every retired entry is then marked by the claim that covered it.
    const claim = s.claim ?? (fp ? { task: newId(env), fingerprint: fp } : null);
    const covered = claim ? claim.fingerprint : fp;
    const retired = s.credential ? [...s.retired, { credential: s.credential, fingerprint: covered, deleted: false, unsubscribed: !covered }] : s.retired;
    const state = { ...s, epoch: s.epoch + 1, credential: null, op: null, needsRotation: false, retired, claim, known: null, renewedAt: null, knownVersion: s.knownVersion + 1 };
    return { state, result: { claim, retired: s.credential } };
  });
}

const tidy = (retired) => retired.filter((r) => !(r.deleted && r.unsubscribed));

/**
 * A claim resolved: cleared if still this task's and its subscription is confirmed gone (`unsubscribed`), or replaced
 * by a claim for another subscription. An unsubscribe that failed keeps the claim, to be tried again.
 */
export function settleClaim(env, { task, unsubscribed, replaceWith = null }) {
  return update(env, (s) => {
    if (s.claim?.task !== task) return { result: null };
    if (!unsubscribed && !replaceWith) return { result: s.claim };
    const fp = s.claim.fingerprint;
    // Replaced: the browser holds another subscription now (one per registration), so the claimed one is gone too.
    const retired = tidy(s.retired.map((r) => ((unsubscribed || replaceWith) && r.fingerprint === fp ? { ...r, unsubscribed: true } : r)));
    const claim = replaceWith ? { task: newId(env), fingerprint: replaceWith } : null;
    return { state: { ...s, claim, retired }, result: claim };
  });
}

export function retiredDeleted(env, { credential }) {
  return update(env, (s) => ({ state: { ...s, retired: tidy(s.retired.map((r) => (r.credential === credential ? { ...r, deleted: true } : r))) }, result: undefined }));
}

/** The rotation flag, for the credential and epoch that read it: a caller from before a turn-off changes nothing. */
export const setNeedsRotation = (env, { on, credential, epoch }) =>
  update(env, (s) => (s.credential === credential && s.epoch === epoch ? { state: { ...s, needsRotation: on }, result: true } : { result: false }));
export const setVapid = (env, key) => update(env, (s) => ({ state: { ...s, vapidKey: key }, result: undefined }));
export const setRenewed = (env, { credential, at }) => update(env, (s) => (s.credential === credential ? { state: { ...s, renewedAt: at }, result: undefined } : { result: undefined }));
export const noteGone = (env, fp) => update(env, (s) => ({ state: { ...s, gone: [...new Set([...s.gone, fp])].slice(-10) }, result: undefined }));

/**
 * The channel release's database (only that release wrote it): 'no' when it does not exist, 'empty' when it holds no
 * credential (it is deleted, and must be), 'yes' with one, or 'unknown' when it cannot be read (setup then waits).
 */
export async function legacyCredential(env) {
  if (!env.indexedDB) return 'no';
  if (env.indexedDB.databases) {
    const list = await env.indexedDB.databases().catch(() => null);
    if (list && !list.some((d) => d.name === LEGACY_DB)) return 'no';
  }
  try {
    const found = await transact(env, 'readonly', (store, done) => {
      const req = store.get(KEY);
      req.onsuccess = () => done(!!req.result?.credential);
    }, LEGACY_DB);
    return found ? 'yes' : 'empty';
  } catch {
    return 'unknown';
  }
}

export function deleteLegacy(env) {
  return new Promise((resolve, reject) => {
    if (!env.indexedDB) return resolve(undefined);
    const req = env.indexedDB.deleteDatabase(LEGACY_DB);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(new Unsupported('the old database could not be deleted'));
    req.onblocked = () => reject(new Unsupported('the old database is open in another tab'));
  });
}
