// Minimal offline + notification click handler
const CACHE = 'acp-coupons-v1';
const ASSETS = [
  '/',
  '/offers.html',
  '/wallet.html'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(()=>new Response('Offline',{status:503})))
  );
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/offers.html'));
});
