// Einfacher Service Worker: macht die App installierbar und merkt sich die eigenen Dateien (inkl. KI-Modelle).
const CACHE = 'jzo-v2';
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  const isModel = u.pathname.endsWith('.onnx');
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(r);
    if (isModel && hit) return hit;                       // Modelle ändern sich nie
    try { const res = await fetch(r); if (res.ok) c.put(r, res.clone()); return res; }   // sonst: immer die neueste Version holen
    catch (e) { if (hit) return hit; throw e; }                                          // ohne Netz: letzte gemerkte Version
  }));
});
