/* Guarda la app en el teléfono para que abra al instante y funcione sin señal.
 * Nunca guarda nada de GitHub: los datos van siempre directo a la red. */
const CACHE = 'gastos-v3';
const ARCHIVOS = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icon-192.png',
  'fonts/instrument-sans.woff2', 'fonts/azeret-mono-500.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Primero lo guardado (rápido y sin señal); en segundo plano se trae la versión nueva.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const guardado = await cache.match(e.request, { ignoreSearch: true });
      const fresco = fetch(e.request)
        .then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; })
        .catch(() => guardado);
      return guardado || fresco;
    }),
  );
});
