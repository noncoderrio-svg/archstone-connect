// Keeps the app usable on a weak connection: the app shell and a recent copy of
// lead data stay available, and notifications arrive when the app is closed.
const SHELL = 'archstone-shell-v1';
const DATA = 'archstone-data-v1';
const CACHED_API = /^\/api\/(leads(\/\d+)?|dashboard|projects|directory|visits|auth\/me)$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await caches.match(request)) ?? (fallbackUrl ? await caches.match(fallbackUrl) : undefined);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(SHELL)).put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (CACHED_API.test(url.pathname)) return event.respondWith(networkFirst(request, DATA));
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/webhooks') || url.pathname.startsWith('/public')) return;
  // The Android app file is large and must always be the latest one.
  if (url.pathname.startsWith('/app/download') || url.pathname.endsWith('.apk')) return;
  if (request.mode === 'navigate') return event.respondWith(networkFirst(request, SHELL, '/'));
  event.respondWith(cacheFirst(request));
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-data') event.waitUntil(caches.delete(DATA));
});

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Archstone Connect', {
      body: data.body ?? '',
      icon: '/icon-192.png',
      data: { link: data.link ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      if (open) {
        open.navigate(link);
        return open.focus();
      }
      return self.clients.openWindow(link);
    }),
  );
});
