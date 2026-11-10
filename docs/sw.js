// Service Worker: (1) macht die App installierbar, (2) merkt sich die eigenen Dateien (inkl. KI-Modelle),
// (3) schaltet die "Cross-Origin-Isolation" ein, damit der Browser mehrere Prozessorkerne für die KI nutzen darf (viel schneller).
const CACHE = 'jzo-v3';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

function iso(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  const isModel = u.pathname.endsWith('.onnx');
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(r);
    if (isModel && hit) return iso(hit);                        // Modelle ändern sich nie
    try { const res = await fetch(r); if (res.ok) c.put(r, res.clone()); return iso(res); }   // sonst immer die neueste Version holen
    catch (err) { if (hit) return iso(hit); throw err; }        // ohne Netz: letzte gemerkte Version
  }));
});
