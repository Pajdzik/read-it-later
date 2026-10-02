const CACHE = "later-public-v1";
const PUBLIC_ASSETS = ["/app.v1.css", "/app.v1.js", "/icons/icon.v3.svg", "/icons/maskable.v3.svg", "/icons/icon-192.v3.png", "/icons/icon-512.v3.png"];
const serviceWorker = self as unknown as ServiceWorkerGlobalScope;

serviceWorker.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PUBLIC_ASSETS))
      .then(() => serviceWorker.skipWaiting()),
  );
});

serviceWorker.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("later-public-") && key !== CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => serviceWorker.clients.claim()),
  );
});

serviceWorker.addEventListener("fetch", (event: FetchEvent) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== serviceWorker.location.origin || !PUBLIC_ASSETS.includes(url.pathname)) return;

  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === "basic") await cache.put(request, response.clone());
    return response;
  }));
});
