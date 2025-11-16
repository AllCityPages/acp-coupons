// service-worker.js — v16
// PWA shell + cache versioning + offline fallback

const SW_VERSION = 'v16';
const CACHE_NAME = `acp-shell-${SW_VERSION}`;

// Keep HTML network-first so layout/JS updates show up quickly
const OFFLINE_FALLBACK_URL = '/offers.html';

// Assets to pre-cache for offline shell
const PRECACHE_URLS = [
  '/',
  '/offers.html',
  '/wallet.html',
  '/theme.css?v=30.4',
  '/shared.js?v=33',
  '/logo.png',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('acp-shell-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Listen for SKIP_WAITING from the page
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Simple strategy:
// - HTML/navigation: network-first, fall back to cached OFFERS
// - Static assets (css/js/png/jpg/svg/webp/ico): cache-first
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Ignore non-HTTP(S)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const isHTML =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  const isStatic =
    /\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname);

  if (isHTML) {
    // HTML: network-first, fallback to cache
    event.respondWith(
      fetch(request)
        .then(response => {
          // Update cache in background
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then(resp => resp || caches.match(OFFLINE_FALLBACK_URL))
        )
    );
    return;
  }

  if (isStatic) {
    // Static: cache-first
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          return response;
        });
      })
    );
    return;
  }

  // Default: just pass through
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
