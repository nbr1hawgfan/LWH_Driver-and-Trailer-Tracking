// LWH Fleet View service worker — caches the app shell only.
// Live fleet data and map tiles always go to the network.
const VERSION = 'fleetview-v1.10.0';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './yard.js', './config.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                       // API calls are POST
  if (url.hostname.endsWith('supabase.co')) return;
  // Google Maps must always load live (and is billed per live load anyway)
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('google.com')) return;

  // Network first for the shell so updates land right away; cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok && url.origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
