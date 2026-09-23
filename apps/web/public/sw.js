// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/* global self, caches, fetch, Response, URL */
/**
 * Service worker ARCOMPT (docs/OFFLINE.md).
 *
 * Trois politiques, pour trois natures de requête :
 *
 *   - STATIQUES (/_next/static, manifeste, icônes) : cache d'abord. Ces
 *     fichiers portent une empreinte dans leur nom, ils ne changent jamais sous
 *     le même URL.
 *   - API (/api/proxy) : réseau d'abord, repli cache pour les GET SEULEMENT.
 *     Une mutation n'est jamais interceptée : c'est la file IndexedDB qui la
 *     porte, avec son identifiant de rejeu. Un service worker qui rejouerait
 *     lui-même un POST le ferait sans idempotence ni ordre.
 *   - NAVIGATIONS : réseau d'abord, repli sur la page en cache, puis sur la
 *     coque hors ligne.
 *
 * L'ajout de cette version : la coque des écrans utiles hors ligne est
 * PRÉCHARGÉE à l'installation. Sans cela, un écran jamais visité en ligne
 * renvoyait /offline.html — y compris le centre de synchronisation, c'est-à-dire
 * l'écran qu'on ouvre précisément quand le réseau manque.
 *
 * Ce qui n'est délibérément PAS préchargé : la balance, le grand livre et les
 * états financiers. Les servir depuis un cache ferait lire des chiffres d'hier
 * en croyant lire ceux d'aujourd'hui.
 */
const VERSION = "v2";
const STATIC_CACHE = `arcompt-static-${VERSION}`;
const API_CACHE = `arcompt-api-${VERSION}`;
const PAGE_CACHE = `arcompt-pages-${VERSION}`;
const KEEP = [STATIC_CACHE, API_CACHE, PAGE_CACHE];

const PRECACHE = ["/offline.html", "/manifest.webmanifest"];

/**
 * Écrans que l'on doit pouvoir ouvrir sans réseau : saisie, consultation de ce
 * qui est en attente, et les listes qui alimentent la saisie. Le préchargement
 * est « au mieux » : un écran refusé par les droits du rôle ne fait pas échouer
 * l'installation.
 */
const SHELL_ROUTES = ["/", "/sync", "/entries", "/entries/new", "/invoices/new", "/expenses/new", "/documents", "/accounts"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => caches.open(PAGE_CACHE))
      .then((pages) => Promise.all(SHELL_ROUTES.map((route) => pages.add(route).catch(() => undefined))))
      .catch(() => undefined),
  );
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
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || /\.(png|svg|ico|woff2?|jpe?g)$/.test(url.pathname)) {
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
