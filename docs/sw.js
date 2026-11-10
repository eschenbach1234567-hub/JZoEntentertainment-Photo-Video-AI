// Einfacher Service Worker: macht die App installierbar und merkt sich die eigenen Dateien (inkl. KI-Modelle).
const CACHE = 'jzo-v1';
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
    const net = fetch(r).then((res) => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;                                    // sonst: sofort aus dem Cache, im Hintergrund erneuern
  }));
});
