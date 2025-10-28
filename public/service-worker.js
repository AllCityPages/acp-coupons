/* service-worker.js — cache v6 */
const VERSION = 'v6';
const STATIC_CACHE = `static-${VERSION}`;
const HTML_CACHE = `html-${VERSION}`;
const STATIC_ASSETS = [
  // Add your core UI shell files here; SW will cache them on install
  '/theme.css',
  '/shared.js',
  '/offers.html',
  '/wallet.html'
];

// Take control ASAP
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(()=>{})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== STATIC_CACHE && k !== HTML_CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Helper: treat navigations and HTML requests with network-first
async function networkFirstHTML(request) {
  try {
    const net = await fetch(request, { cache: 'no-store' });
    const cache = await caches.open(HTML_CACHE);
    cache.put(request, net.clone());
    return net;
  } catch (err) {
    const cache = await caches.open(HTML_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Helper: cache-first for static assets (css/js/images)
async function cacheFirstStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const net = await fetch(request);
  // Only cache successful, likely-static responses
  if (net.ok && (/\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i).test(new URL(request.url).pathname)) {
    cache.put(request, net.clone());
  }
  return net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET
  if (req.method !== 'GET') return;

  // HTML / navigations → network-first
  const isHTML =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // Everything else → cache-first
  event.respondWith(cacheFirstStatic(req));
});

// Allow page to force activation immediately
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
