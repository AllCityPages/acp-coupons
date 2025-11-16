// service-worker.js — v15
// - Do NOT cache HTML pages (offers.html, wallet.html, etc.)
// - Cache versioned static assets only (CSS/JS/images)

const CACHE_VERSION = 'acp-static-v15';
const PRECACHE = [
  '/theme.css?v=30.4',
  '/shared.js?v=32',
  '/logo.png'
];

// Install: pre-cache core static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network for HTML, cache-first for static assets
self.addEventListener('fetch', event => {
  const req = event.request;

  // 1) Never intercept HTML pages – always go to network
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    // Let the browser handle this (no respondWith) so it hits the server
    return;
  }

  // 2) Cache-first for everything else (CSS, JS, images)
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (req.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, clone));
        }
        return resp;
      });
    })
  );
});
