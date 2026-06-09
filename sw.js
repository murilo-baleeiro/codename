const CACHE = "codename-v1";
const URLS = [
  "/",
  "/mestre",
  "/palavras",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => {
      return cache.addAll(URLS).catch((err) => {
        console.warn("[SW] Falha ao cachear alguns recursos:", err);
      });
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
    }),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request).catch(() => {
        return caches.match("/palavras");
      });
    }),
  );
});
