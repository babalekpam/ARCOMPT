/* global self, caches, fetch, Response, URL */
/**
 * Service worker ARCOMPT : coque applicative en cache.
 * - statiques (/_next/static, manifeste, icônes) : cache d'abord ;
 * - API (/api/proxy) : réseau d'abord, repli cache pour les GET, jamais de cache pour le reste ;
 * - navigations : réseau d'abord, repli sur la page en cache puis /offline.html.
 * Les données comptables restent éphémères : le cache API est purgé à chaque nouvelle version.
 */
const VERSION = "v1";
const STATIC_CACHE = `arcompt-static-${VERSION}`;
const API_CACHE = `arcompt-api-${VERSION}`;
const PAGE_CACHE = `arcompt-pages-${VERSION}`;
const KEEP = [STATIC_CACHE, API_CACHE, PAGE_CACHE];
const PRECACHE = ["/offline.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("arcompt-") && !KEEP.includes(k)).map((k) => caches["delete"](k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (fallbackUrl) {
      const fb = await caches.match(fallbackUrl);
      if (fb) return fb;
    }
    return new Response(JSON.stringify({ error: { code: "OFFLINE", message: "Hors ligne" } }), { status: 503, headers: { "content-type": "application/json" } });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET") return; // mutations : jamais interceptées, la file IndexedDB s'en charge
  if (url.pathname.startsWith("/api/auth") || url.pathname.startsWith("/api/session")) return; // session : toujours le réseau
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || /\.(png|svg|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (url.pathname.startsWith("/api/proxy/")) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, PAGE_CACHE, "/offline.html"));
  }
});
