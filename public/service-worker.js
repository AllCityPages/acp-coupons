/* service-worker.js — cache v7 (API bypass) */
const VERSION = 'v7';
const STATIC_CACHE = `static-${VERSION}`;
const HTML_CACHE   = `html-${VERSION}`;
const STATIC_ASSETS = [
  '/theme.css',
  '/shared.js',
  '/offers.html',
  '/wallet.html',
];

/* ---------- Install: pre-cache core assets & take control ---------- */
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(()=>{})
  );
});

/* ---------- Activate: clean old caches & claim clients ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, HTML_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------- Helpers ---------- */
async function networkFirstHTML(request) {
  try {
    const net = await fetch(request, { cache: 'no-store' });
    const cache = await caches.open(HTML_CACHE);
    cache.put(request, net.clone());
    return net;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}
async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const net = await fetch(request);
  const pathname = new URL(request.url).pathname;
  if (net.ok && /\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i.test(pathname)) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, net.clone());
  }
  return net;
}
async function networkOnlyNoStore(request) {
  // Always hit the network; do not cache results
  return fetch(request, { cache: 'no-store' });
}

/* ---------- Fetch router ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ✅ Never cache API/QR/coupon resources (fresh on every request)
  const isApi = url.pathname.startsWith('/api/');
  const isOfferJson = url.pathname === '/offers.json';
  const isQr = url.pathname.startsWith('/qr');
  const isCoupon = url.pathname.startsWith('/coupon');
  if (isApi || isOfferJson || isQr || isCoupon) {
    event.respondWith(networkOnlyNoStore(req));
    return;
  }

  // HTML navigations → network-first (so updates show up), fallback to cache
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // Everything else (css/js/images/fonts) → cache-first
  event.respondWith(cacheFirstStatic(req));
});

/* ---------- Allow pages to trigger immediate activation ---------- */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
