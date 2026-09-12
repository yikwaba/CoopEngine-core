/* Co-opEngine member PWA service worker.
 *
 * Strategy:
 *   - API calls are never cached (always network) so balances are never stale.
 *   - Navigations are network-first with a cached fallback so the app opens
 *     on a poor connection.
 *   - Static assets are cache-first.
 */
const CACHE = 'coopengine-shell-v2';
const SHELL = ['/', '/loans', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API traffic.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match('/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request)
          .then((res) => {
            if (res.ok && url.pathname.startsWith('/_next/')) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => hit),
    ),
  );
});
