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
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
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

/* __SHARED__ */

const swEnv = { indexedDB: self.indexedDB, locks: self.navigator?.locks, crypto: self.crypto };

self.addEventListener('message', (event) => {
  if (event.data?.type === 'capabilities') event.ports?.[0]?.postMessage({ version: VERSION, push: true });
});

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data?.json() ?? null;
  } catch {
    data = null;
  }
  const ok = data?.v === 1;
  // Never silent: a push that shows nothing loses the permission in Chrome.
  const title = ok && typeof data.title === 'string' ? data.title : 'New dates are open';
  const options = {
    body: ok && typeof data.body === 'string' ? data.body : 'Open PengePassportPH to see them.',
    data: ok && data.url && typeof data.url === 'object' ? data.url : null,
    icon: `${scope}icons/icon-192.png`,
    badge: `${scope}icons/badge-96.png`,
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

self.addEventListener('pushsubscriptionchange', (event) => {
  // A fast path only: the page also reconciles every time it opens.
  if (!swEnv.locks || !swEnv.indexedDB) return;
  const post = (path, body, method = 'POST') =>
    fetch(`${self.registration.scope}${path.slice(1)}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  // (`fetch` here is the worker's global; the test harness passes its own into the worker's scope.)
  event.waitUntil(reconcile(swEnv, { registration: self.registration, post, permission: 'granted' }).catch(() => undefined));
});
