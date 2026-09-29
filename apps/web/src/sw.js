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
