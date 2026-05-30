const CACHE = 'ahh-v22';

// Fichiers JAMAIS mis en cache — toujours chargés depuis le réseau
const NO_CACHE = [
  '/sw.js', '/script.js', '/_nav.js', '/_lang.js', '/style.css',
  '/', '/index.html',
  '/dashboard/app.html', '/dashboard/dashboard.css', '/dashboard/dashboard.js',
  '/scan.html', '/ticket.html', '/print-tickets.html',
  '/billets.html', '/activity-checkout.html', '/carte.html'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API calls et fichiers critiques: toujours réseau
  if (url.pathname.startsWith('/api/')) return;
  if (NO_CACHE.includes(url.pathname)) return;
  // Polices Google: réseau uniquement (CORS)
  if (url.hostname.includes('fonts.')) return;
  // Autres: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => {});
    })
  );
});
