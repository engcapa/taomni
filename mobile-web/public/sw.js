// Only public shell assets are cached. Tokens, APIs, terminal/file/diff data
// are never written to CacheStorage. Build replaces the shell revision.
const CACHE = "taomni-mobile-__REVISION__";
const PRECACHE = __PRECACHE__;
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname !== "/" && !url.pathname.startsWith("/assets/") && !["/manifest.webmanifest", "/icon.svg"].includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
