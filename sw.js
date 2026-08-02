const CACHE = 'ahh-v76';
const TICKET_STORE = 'ahh-tickets-offline';

// Fichiers JAMAIS mis en cache — toujours chargés depuis le réseau
const NO_CACHE = [
  '/sw.js', '/script.js', '/_nav.js', '/_lang.js', '/style.css',
  '/', '/index.html', '/equipe.html',
  '/dashboard/app.html', '/dashboard/dashboard.css', '/dashboard/dashboard.js',
  '/scan.html', '/ticket.html', '/print-tickets.html',
  '/billets.html', '/activity-checkout.html', '/carte.html'
];

// ── IndexedDB helpers pour tickets hors-ligne ─────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TICKET_STORE, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tickets')) {
        const store = db.createObjectStore('tickets', { keyPath: 'qr_data' });
        store.createIndex('activity_id', 'activity_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('checkins')) {
        db.createObjectStore('checkins', { keyPath: 'qr_data' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeTickets(activityId, tickets) {
  const db = await openDB();
  const tx = db.transaction('tickets', 'readwrite');
  const store = tx.objectStore('tickets');
  tickets.forEach(t => { try { store.put({ ...t, activity_id: activityId }); } catch {} });
  return new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
}

async function getTicket(qrData) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction('tickets', 'readonly');
    const req = tx.objectStore('tickets').get(qrData);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function markCheckedIn(qrData) {
  const db = await openDB();
  const tx = db.transaction(['tickets','checkins'], 'readwrite');
  const ticket = await new Promise(r => {
    const req = tx.objectStore('tickets').get(qrData);
    req.onsuccess = () => r(req.result);
    req.onerror = () => r(null);
  });
  if (ticket) {
    ticket.checked_in = 1;
    ticket.date_checkin = new Date().toISOString();
    tx.objectStore('tickets').put(ticket);
    tx.objectStore('checkins').put({ qr_data: qrData, synced: 0, date_checkin: ticket.date_checkin, activity_id: ticket.activity_id });
  }
  return new Promise(r => { tx.oncomplete = () => r(ticket); tx.onerror = () => r(null); });
}

async function getPendingCheckins() {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction('checkins', 'readonly');
    const req = tx.objectStore('checkins').getAll();
    req.onsuccess = () => resolve((req.result || []).filter(c => !c.synced));
    req.onerror = () => resolve([]);
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()).then(() => {
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
      });
    })
  );
});

// ── Push notifications ────────────────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title:'AHH', body:'Nouvelle notification' };
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/Public/logo1.png',
    badge: '/Public/logo1.png',
    data: { url: data.url || '/dashboard/app.html' },
    vibrate: [200, 100, 200]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/dashboard/app.html'));
});

// ── Messages depuis les pages ─────────────────────────────────────────────
self.addEventListener('message', async e => {
  if (e.data?.type === 'CACHE_TICKETS') {
    // La page scan.html envoie les tickets à mettre en cache
    const { activityId, tickets } = e.data;
    await storeTickets(activityId, tickets || []);
    e.ports[0]?.postMessage({ ok: true, count: tickets?.length || 0 });
  } else if (e.data?.type === 'SYNC_CHECKINS') {
    // Sync des check-ins faits hors-ligne
    const pending = await getPendingCheckins();
    e.ports[0]?.postMessage({ pending: pending.length });
  }
});

// ── Fetch interceptor ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Valider billet en mode hors-ligne
  if (url.pathname === '/api/tickets/checkin' && e.request.method === 'POST') {
    e.respondWith((async () => {
      // Essayer le réseau d'abord
      try {
        const resp = await fetch(e.request.clone(), { signal: AbortSignal.timeout(3000) });
        return resp;
      } catch {
        // Hors-ligne : vérifier dans IndexedDB
        try {
          const body = await e.request.json();
          const qr = body.qr_data || body.ticket_qr;
          if (!qr) return new Response(JSON.stringify({ error: 'QR manquant' }), { status: 400, headers: {'Content-Type':'application/json'} });
          const ticket = await getTicket(qr);
          if (!ticket) return new Response(JSON.stringify({ status: 'inconnu', message: 'Billet non trouvé (hors-ligne)' }), { status: 404, headers: {'Content-Type':'application/json'} });
          if (ticket.checked_in) return new Response(JSON.stringify({ status: 'deja_scanne', message: 'Déjà scanné', ticket }), { headers: {'Content-Type':'application/json'} });
          const updated = await markCheckedIn(qr);
          return new Response(JSON.stringify({ status: 'ok', offline: true, message: 'Validé hors-ligne (sync à venir)', ticket: updated }), { headers: {'Content-Type':'application/json'} });
        } catch(err) {
          return new Response(JSON.stringify({ error: 'Erreur hors-ligne' }), { status: 500, headers: {'Content-Type':'application/json'} });
        }
      }
    })());
    return;
  }

  // API calls : réseau uniquement (sauf ticket checkin ci-dessus)
  if (url.pathname.startsWith('/api/')) return;
  if (NO_CACHE.includes(url.pathname)) return;
  // Polices Google : réseau uniquement (CORS)
  if (url.hostname.includes('fonts.')) return;

  // Autres : cache-first
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
