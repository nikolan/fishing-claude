// Service worker.
//
// The shell is stale-while-revalidate: a cached copy answers immediately, and a
// fresh copy is fetched in the background and stored for next time. When the
// fresh copy differs from the cached one the page is told, so it can offer a
// reload instead of silently showing an old build.
//
// It used to be cache-first with a fixed version, which meant a deployed change
// never reached a phone that had already installed the app. The scoring could be
// rewritten and the towpath would still show the old numbers.
//
// API calls stay network-first with a cached fallback, so the last forecast
// still shows with no signal.
const VERSION = 'v3';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './src/engine.js',
  './src/astro.js',
  './src/timezone.js',
  './src/data.js',
  './src/ea.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isApi = (url) => /open-meteo\.com|gov\.uk\/bank-holidays|environment\.data\.gov\.uk/.test(url.hostname + url.pathname);

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  if (isApi(url)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit || Response.error())),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

/** A version tag for a response, used to spot a changed build. */
const tagOf = (res) => res.headers.get('etag') || res.headers.get('last-modified') || null;

async function announceUpdate() {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.postMessage({ type: 'shell-updated' });
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);

  const fresh = fetch(request)
    .then(async (res) => {
      if (res.ok) {
        const before = hit ? tagOf(hit) : null;
        const after = tagOf(res);
        await cache.put(request, res.clone());
        // Only shout when we can actually tell the two apart.
        if (hit && before && after && before !== after) await announceUpdate();
      }
      return res;
    })
    .catch(() => hit);

  return hit || fresh;
}
