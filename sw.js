/* Guarda la app en el teléfono para que abra al instante y funcione sin señal.
 * Nunca guarda nada de GitHub: los datos van siempre directo a la red. */
const CACHE = 'gastos-v6';
const ARCHIVOS = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icon-192.png',
  'fonts/instrument-sans.woff2', 'fonts/azeret-mono-500.woff2'];

self.addEventListener('install', (e) => {
  // 'reload' saltea la caché del navegador: la versión nueva se baja entera y fresca.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ARCHIVOS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
  // Siempre lo guardado al instalar esta versión: así nunca se mezclan archivos de dos versiones.
  // Una versión nueva llega entera, con un sw.js nuevo, y la app se recarga cuando queda lista.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const guardado = await cache.match(e.request, { ignoreSearch: true });
      return guardado || fetch(e.request);
    }),
  );
});
