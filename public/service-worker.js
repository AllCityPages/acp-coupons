/* service-worker.js — cache v6 */
const VERSION = 'v6';
const STATIC_CACHE = `static-${VERSION}`;
const HTML_CACHE = `html-${VERSION}`;
const STATIC_ASSETS = [
  '/theme.css',
  '/shared.js',
  '/offers.html',
  '/wallet.html',
];

/* Install: pre-cache core assets and take control immediately */
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(()=>{})
  );
});

/* Activate: clean old caches and claim clients */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => ![STATIC_CACHE, HTML_CACHE].includes(k)).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* Strategy helpers */
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

/* Fetch router */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) { event.respondWith(networkFirstHTML(req)); return; }

  event.respondWith(cacheFirstStatic(req));
});

/* Allow page to skip waiting right away */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
