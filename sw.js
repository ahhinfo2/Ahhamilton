const CACHE = 'ahh-v18';
const STATIC = [
  '/', '/index.html', '/style.css',
  '/actualites.html', '/talents.html', '/annonces.html', '/galerie.html',
  '/about.html', '/equipe.html', '/adhesion.html', '/carte.html',
  '/dashboard/app.html', '/dashboard/login.html',
  '/dashboard/dashboard.css', '/dashboard/dashboard.js',
  '/Public/logo1.png',
  'https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800&family=Playfair+Display:wght@600;700&display=swap'
];

// Fichiers jamais mis en cache (toujours réseau — mises à jour fréquentes)
const NO_CACHE = ['/sw.js', '/script.js', '/_nav.js', '/style.css', '/scan.html', '/ticket.html', '/billets.html', '/activity-checkout.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC.map(u => new Request(u, { cache: 'reload' }))).catch(() => {}))
  );
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
  // API calls: network-first, no cache
  if (url.pathname.startsWith('/api/')) return;
  // Fichiers critiques: toujours réseau
  if (NO_CACHE.includes(url.pathname)) return;
  // Everything else: cache-first, fall back to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
