// The service worker (sw-plugin.ts builds it into sw.js with this build's file
// list). It keeps the app itself on the device so it opens without a connection.
// Appointment data never is kept: /api/ always goes to the network, so a date on
// screen is live, or the app says it could not reach the server.
const VERSION = '__VERSION__';
// Caches belong to the whole origin, which other apps share: this one's are named for it.
const PREFIX = 'pengepassportph-';
const CACHE = `${PREFIX}${VERSION}`;
const SHELL = __SHELL__;
const scope = new URL(self.registration.scope).pathname;
// A file is the same whatever the request looked like: a server that answers with
// "Vary: Origin" would otherwise miss module scripts, which send an Origin header.
const STORED = { cacheName: CACHE, ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

// A new build's worker takes over at once and drops the last build's files.
// The first activation of a worker of this design reloads every page an earlier worker controlled, so no page of an
// older release (which could touch the browser's subscription) stays open (spec: "Old pages and the shared
// subscription"). Those pages are listed before claim(): the pages claim() adopts are first visits, already of this
// release, and reloading them would only interrupt the person (a form being filled, a setup running).
const MARKER = `${PREFIX}device-alerts-v1`;

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE && key !== MARKER).map((key) => caches.delete(key)));
      const earlier = await self.clients.matchAll({ type: 'window' });
      await self.clients.claim();
      if (await caches.has(MARKER)) return;
      await caches.open(MARKER);
      // Started, never awaited: a navigation settles only once it commits, which waits for this activation (Chromium).
      for (const client of earlier) void Promise.resolve(client.navigate?.(client.url)).catch(() => undefined);
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return;
  if (url.pathname.startsWith(`${scope}api/`)) return;

  if (request.mode === 'navigate') {
    // The network first, so a deploy shows at once; offline, the app kept on the device.
    event.respondWith(fetch(request).catch(() => caches.match(scope, STORED).then((page) => page ?? Response.error())));
    return;
  }
  if (url.pathname.startsWith(`${scope}assets/`) || SHELL.includes(url.pathname.slice(scope.length))) {
    // A build's files never change under the same name.
    event.respondWith(caches.match(request, STORED).then((hit) => hit ?? fetch(request)));
  }
});

/* __STATE__ */

const env = { indexedDB: self.indexedDB, locks: self.navigator?.locks, crypto: self.crypto };
const ICONS = { icon: `${scope}icons/icon-192.png`, badge: `${scope}icons/badge-96.png` };
const TERMINAL = ['active', 'expired', 'changed', 'full', 'owner-only', 'gone', 'failed'];
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
// Every request, its body included, ends within 15 s (as the page's client): a push event is never held by one.
const api = (path, credential, body, method = 'POST') => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  return fetch(`${self.registration.scope}api/device-alerts${path}`, {
    method,
    signal: abort.signal,
    headers: { authorization: `Device ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))
    .finally(() => clearTimeout(timer));
};

self.addEventListener('message', (event) => {
  const port = event.ports?.[0];
  if (event.data?.type === 'capabilities') port?.postMessage({ version: VERSION, push: true, deviceAlerts: 1 });
  if (event.data?.type === 'read-operation') {
    event.waitUntil?.(readState(env).then((s) => port?.postMessage({ op: s.op?.op ?? null }), () => port?.postMessage({ op: null })));
  }
});

async function currentFingerprint() {
  const sub = await self.registration.pushManager.getSubscription();
  return sub ? fingerprint(env, sub.toJSON()) : null;
}

/**
 * Before each step: the credential is not retired, the browser's subscription still has the operation's fingerprint,
 * and the push's op is the operation in progress, or (after acknowledging) its activation is what the device knows.
 */
async function stillOurs(data, credential, activation) {
  const fp = await currentFingerprint();
  return update(env, (s) => {
    if (!s.credential || (credential && s.credential !== credential)) return { result: null };
    // Before the result: this push's operation, still in progress, with the browser's subscription.
    if (!activation) return s.op?.op === data.op && !s.op.result && s.op.fingerprint === fp ? { result: s } : { result: null };
    // After it: the activation is the alert the device knows, with the browser's subscription.
    const k = s.known;
    if (k && k.incarnation === activation.incarnation && k.generation === activation.generation && k.fingerprint === fp) return { result: s };
    return { result: null };
  });
}

async function setupPush(data) {
  const tag = `setup-${data.op}`;
  const show = (title, body) => self.registration.showNotification(title, { body, tag, data: {}, ...ICONS });
  const didntFinish = () => show("This notification setup didn't finish.", 'Open PengePassportPH to see whether notifications are on.');
  /**
   * When this push's operation is no longer in progress: its recorded result is the answer (the page acknowledged, or
   * this push came again); if the page finished it and moved on (a newer operation, an alert known on the browser's
   * subscription), this notification goes quietly; otherwise it did not finish.
   */
  const fallback = async (credential) => {
    const t = await readState(env);
    if (t.credential && (!credential || t.credential === credential) && t.op?.op === data.op && t.op.result) {
      return { answer: { result: t.op.result, activation: t.op.activation }, credential: t.credential };
    }
    const now = await currentFingerprint();
    if (t.credential && (!credential || t.credential === credential) && t.op && t.op.op !== data.op && t.known && t.known.fingerprint === now) {
      for (const n of await self.registration.getNotifications({ tag })) n.close();
      return { quiet: true };
    }
    return { failed: true };
  };
  let answer = null;
  let credential = null;
  const s = await stillOurs(data);
  if (!s) {
    const f = await fallback(null);
    if (f.quiet) return;
    if (f.failed) return didntFinish();
    answer = f.answer;
    credential = f.credential;
  } else {
    try {
      await show('Setting up notifications…', 'This shows notifications work on this device.');
    } catch {
      return; // The proof is that this browser shows it: no acknowledgement without it.
    }
    credential = s.credential;
    const recover = async () => {
      const f = await fallback(credential);
      if (f.quiet) return 'quiet';
      if (f.failed) return 'failed';
      answer = f.answer;
      return 'answer';
    };
    if (!(await stillOurs(data, credential))) {
      const r = await recover();
      if (r === 'quiet') return;
      if (r === 'failed') return didntFinish();
    } else if (!(await storeNonce(env, { op: data.op, credential, fingerprint: s.op.fingerprint, nonce: data.nonce }))) {
      const r = await recover();
      if (r === 'quiet') return;
      if (r === 'failed') return didntFinish();
    } else {
      for (const wait of [0, 2000, 6000]) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (!(await stillOurs(data, credential))) {
          const r = await recover();
          if (r === 'quiet') return;
          if (r === 'failed') return didntFinish();
          break;
        }
        try {
          const r = await api('/ready', credential, { op: data.op, nonce: data.nonce });
          if (r.status === 200 && typeof r.data?.result === 'string') {
            answer = r.data;
            break;
          }
        } catch {
          // No connection: try again, then leave it to the page (the nonce is stored).
        }
      }
    }
  }
  // No answer, or one that is not a result (unknown: the operation moved on while the request was out): the same
  // fallback first, so a setup the page finished meanwhile is never contradicted.
  if (!answer || !TERMINAL.includes(answer.result)) {
    const f = await fallback(credential);
    if (f.quiet) return;
    if (f.answer) answer = f.answer;
  }
  if (!answer) {
    // Still this device's setup in progress, with its subscription: it may yet finish (the page sends the stored nonce).
    // Turned off meanwhile, or the subscription changed: it did not finish.
    const t = await readState(env);
    const now = await currentFingerprint();
    if (t.credential !== credential || t.op?.op !== data.op || t.op.result || t.op.fingerprint !== now) return didntFinish();
    return show("Couldn't confirm the setup yet.", 'Open PengePassportPH to finish.');
  }
  if (!TERMINAL.includes(answer.result)) return didntFinish();
  await recordResult(env, { op: data.op, credential, result: answer.result, activation: answer.activation ?? null });
  if (answer.result === 'active') {
    // The version before the read: anything that changes `known` while it is out (a newer read, a turn-off) wins.
    const before = await readState(env);
    const mine = await api('/mine', credential, null, 'GET').catch(() => null);
    const a = mine?.data?.state === 'active' ? mine.data.alert : null;
    const act = answer.activation;
    // Not the server's alert (or no answer): quiet if the page has moved on, else it did not finish.
    const notShown = async () => ((await fallback(credential)).quiet ? undefined : didntFinish());
    if (!a || !act || a.incarnation !== act.incarnation || a.generation !== act.generation) return notShown();
    // Remembered as the alert this device knows (fenced by the version from before the read), so a later subscription
    // change can rotate it before the page opens; then shown only if it is the known alert (a refused write leaves the
    // newer state, which the check below then judges).
    if (before.credential === credential) {
      const k = { alertId: a.alertId, incarnation: a.incarnation, generation: a.generation, revision: a.revision, fingerprint: a.fingerprint, endsAt: Date.parse(a.endsAt), choices: a.choices };
      await setKnown(env, { credential, known: k, version: before.knownVersion });
    }
    if (!(await stillOurs(data, credential, act))) return notShown();
    await show('Notifications are ready', `You'll get a notification like this when dates open at ${typeof data.body === 'string' ? data.body : 'your offices'}.`);
    // After showing it: still this credential, and the activation still the alert the device knows (or the operation).
    if (!(await stillOurs(data, credential, act))) await notShown();
    return;
  }
  if (answer.result === 'changed') {
    for (const n of await self.registration.getNotifications({ tag })) n.close();
    return;
  }
  if (answer.result === 'expired') return show('Setting up notifications took too long.', 'Open PengePassportPH to try again.');
  if (answer.result === 'full') return show('Notifications are full right now.', 'Email alerts still work.');
  return didntFinish();
}

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data?.json() ?? null;
  } catch {
    data = null;
  }
  const ok = data?.v === 1;
  if (ok && data.kind === 'setup' && typeof data.op === 'string' && typeof data.nonce === 'string' && env.locks && env.indexedDB) {
    event.waitUntil(setupPush(data).catch(() => self.registration.showNotification("This notification setup didn't finish.", { tag: `setup-${data.op}`, ...ICONS })));
    return;
  }
  // Never silent: a push that shows nothing loses the permission in Chrome.
  const title = ok && typeof data.title === 'string' ? data.title : 'New dates are open';
  const options = {
    body: ok && typeof data.body === 'string' ? data.body : 'Open PengePassportPH to see them.',
    data: ok && data.url && typeof data.url === 'object' ? data.url : null,
    ...ICONS,
  };
  if (ok && typeof data.tag === 'string') options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const u = event.notification.data ?? {};
  const q = new URLSearchParams();
  if (Number.isSafeInteger(u.office) && u.office > 0) q.set('office', String(u.office));
  if (typeof u.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u.date)) q.set('date', u.date);
  if (Number.isSafeInteger(u.people) && u.people >= 1 && u.people <= 5) q.set('people', String(u.people));
  const query = q.toString();
  const target = `${self.registration.scope}${query ? `?${query}` : ''}`;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      const mine = list.find((c) => c.url.startsWith(self.registration.scope));
      if (mine) {
        try {
          const moved = (await mine.navigate?.(target)) ?? mine;
          return await moved.focus();
        } catch {
          // A tab this worker does not control cannot be moved: open the office in a new one.
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

// The push service replaced the subscription: a rotation, with this device's credential (no owner token), or a join of
// the one in progress. The page drives it on its next opening; here it is started.
self.addEventListener('pushsubscriptionchange', (event) => {
  if (!env.locks || !env.indexedDB) return;
  event.waitUntil(
    (async () => {
      // The flag for the credential and epoch read now (a turn-off since then changes nothing); none, nothing to rotate.
      const s0 = await readState(env);
      if (!s0.credential) return;
      await setNeedsRotation(env, { on: true, credential: s0.credential, epoch: s0.epoch });
      let captured = null;
      // At most two tries: the second only after a "changed" answer, against the alert read again.
      for (let attempt = 0; attempt < 2; attempt++) {
        const s = await readState(env);
        if (!s.credential || !s.known) return;
        captured ??= { incarnation: s.known.incarnation, generation: s.known.generation };
        // Prepared under the driver lock, as the page prepares (its recovery takes it too, so it never adopts or drops a
        // rotation this worker is still preparing). A page holding it carries the rotation on (needsRotation is set).
        const prepared = await env.locks.request(DRIVER_LOCK, { ifAvailable: true }, async (lock) => {
          if (!lock) return null;
          // Only for the credential and epoch this rotation was decided under: never after a turn-off.
          const r = await begin(env, { kind: 'rotate', choices: null, captured, now: Date.now(), expect: { credential: s0.credential, epoch: s0.epoch } });
          if (!r.started) return null;
          let sub = event.newSubscription ?? (await self.registration.pushManager.getSubscription());
          if (!sub && self.Notification?.permission === 'granted' && s.vapidKey) {
            sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(s.vapidKey) }).catch(() => null);
          }
          if (!sub) return finish(env, { op: r.started.op }).then(() => null);
          const json = sub.toJSON();
          const fp = await fingerprint(env, json);
          const by = newId(env);
          const attached = await attach(env, { op: r.started.op, epoch: r.started.epoch, subscription: json, fingerprint: fp, by });
          // A page recovering this rotation attached it first: its stored request stands, and the page sends it.
          if (attached === 'already') return null;
          if (attached !== 'ok') {
            // Turned off meanwhile (another epoch): a subscription made for this rotation goes, unless something uses it.
            const claim = await abandon(env, { op: r.started.op, fingerprint: fp, by: null });
            if (claim) {
              const ok = await sub.unsubscribe().catch(() => false);
              await settleClaim(env, { task: claim.task, unsubscribed: ok });
            }
            return null;
          }
          // The worker reads its own storage: no handshake; ready at once, unless turned off meanwhile.
          if (!(await confirmReady(env, { op: r.started.op, by }))) return null;
          return { r, json, fp };
        });
        if (!prepared) return;
        const { r, json, fp } = prepared;
        const res = await api('/mine/subscription', r.credential, { op: r.started.op, seq: r.started.seq, subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, captured }).catch(() => null);
        const outcome = res?.data?.outcome;
        if (outcome === 'pending' || outcome === 'done') {
          // Admitted: 'sent', with the deadline on this device's clock (the server's remaining time from now).
          const remaining = res.data.operation?.remainingMs;
          await markSent(env, { op: r.started.op, expiresAt: typeof remaining === 'number' ? Date.now() + remaining : null });
          return;
        }
        // No answer, limited or busy: left ready and unsent; the page sends the same request at its next opening.
        if (!outcome || outcome === 'limited' || outcome === 'busy') return;
        // Refused before anything was stored: a terminal result, kept for the page to show.
        const result = outcome === 'off' ? 'unavailable' : outcome === 'invalid' ? 'failed' : outcome;
        await recordResult(env, { op: r.started.op, credential: r.credential, result, activation: null });
        if (outcome !== 'changed') return;
        // Another rotation or a re-setup won meanwhile: read the alert again and rotate once more against it, if the
        // credential, the epoch and the browser's subscription are as they were, and the winner did not already
        // register this subscription.
        const now = await readState(env);
        const cur = await self.registration.pushManager.getSubscription();
        if (now.credential !== r.credential || now.epoch !== r.started.epoch || !cur || (await fingerprint(env, cur.toJSON())) !== fp) return;
        const mine = await api('/mine', r.credential, null, 'GET').catch(() => null);
        if (mine?.data?.state !== 'active' || mine.data.alert.fingerprint === fp) return;
        captured = { incarnation: mine.data.alert.incarnation, generation: mine.data.alert.generation };
      }
    })().catch(() => undefined),
  );
});
