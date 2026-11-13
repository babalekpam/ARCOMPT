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
 *     coquille de l'application (le routeur client affiche l'écran demandé),
 *     et seulement en tout dernier sur la page hors ligne statique.
 *
 * L'ajout de la v6 : la coque des écrans utiles hors ligne est
 * PRÉCHARGÉE à l'installation. Sans cela, un écran jamais visité en ligne
 * renvoyait /offline.html — y compris le centre de synchronisation, c'est-à-dire
 * l'écran qu'on ouvre précisément quand le réseau manque.
 *
 * L'ajout de la v7 : une visite en ligne ne détruit plus le document
 * précaché. Les écrans sont servis « private, no-store » ; l'ancien repli
 * supprimait leur entrée du cache au nom de cette politique, et /sync —
 * l'écran d'atterrissage après une saisie hors ligne — affichait alors le
 * tableau de bord à la mauvaise adresse.
 *
 * Ce qui n'est délibérément PAS préchargé : la balance, le grand livre et les
 * états financiers. Les servir depuis un cache ferait lire des chiffres d'hier
 * en croyant lire ceux d'aujourd'hui.
 */
const VERSION = "v7";
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
const SHELL_ROUTES = ["/", "/dashboard", "/sync", "/entries", "/entries/new", "/invoices/new", "/expenses/new", "/documents", "/accounts"];

self.addEventListener("install", (event) => {
  // Une mise à jour de l'application doit s'appliquer dès l'ouverture
  // suivante : sans skipWaiting, l'ancien worker (et ses pages en cache)
  // survivaient jusqu'à la fermeture complète de l'application installée.
  self.skipWaiting();
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
    // HttpOnly admin-mode cookies cannot safely partition a browser cache.
    // Respect the server's private/no-store boundary for authenticated data.
    const policy = res.headers.get("cache-control") || "";
    if (res.ok && !/\b(no-store|private)\b/i.test(policy)) cache.put(request, res.clone());
    else await cache.delete(request);
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

/**
 * Ordre de repli d'une navigation sans réseau. Le document exact d'abord ;
 * sinon la coquille de l'application — le tableau de bord, racine des écrans
 * authentifiés — puis les autres écrans précachés. /offline.html n'arrive
 * qu'en tout dernier : quand AUCUN document de l'application n'est conservé.
 */
const SHELL_FALLBACKS = ["/dashboard", ...SHELL_ROUTES];

/**
 * Navigations : réseau d'abord, puis le cache — mais pas seulement la page
 * demandée.
 *
 * Le défaut corrigé ici a été constaté en conditions réelles : un écran
 * atteint par la navigation INTERNE (lien de la coque, sans rechargement)
 * n'a jamais produit de document à conserver. Le rechargement hors ligne de
 * cet écran tombait donc dans le vide, puis sur /offline.html — alors même
 * que l'application entière était sur l'appareil. Le lancement de
 * l'application installée est lui aussi une navigation fraîche : il
 * subissait le même sort.
 *
 * Le repli « coquille » sert le document racine conservé et laisse le
 * routeur client afficher l'écran demandé : l'application s'ouvre, la file
 * et les copies locales sont là. Mieux vaut le tableau de bord à l'adresse
 * /sync qu'une page d'erreur qui fait croire que rien n'est conservé.
 */
async function navigationResponse(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(request);
    // Conservation : seulement si le serveur l'autorise. Les écrans de
    // l'application lisent les cookies (langue, session) et sont servis
    // « private, no-store » : leur réponse fraîche n'est donc jamais
    // conservée — mais elle ne doit pas non plus DÉTRUIRE le document
    // précaché à l'installation, qui est le filet hors ligne.
    //
    // Le défaut corrigé (constaté en e2e le 2026-10-29) : l'ancien code
    // supprimait l'entrée existante dès que la politique interdisait la
    // conservation. Or l'écran le plus visité en navigation document —
    // /sync, ouvert en ligne avant de partir — perdait ainsi son document
    // précaché. Après l'enregistrement hors ligne d'un devis, le routeur
    // aboutit à /sync en navigation document ; le document exact manquait,
    // le repli « coquille » servait le document du tableau de bord à
    // l'adresse /sync : l'utilisateur voyait le tableau de bord là où le
    // centre de synchronisation était attendu.
    //
    // En ligne, rien ne change pour l'utilisateur : réseau d'abord, la
    // réponse fraîche est toujours celle qui est servie. Le document
    // conservé n'est lu que sans réseau, et ses données viennent alors
    // d'IndexedDB et du cache API, pas du HTML précaché.
    const policy = res.headers.get("cache-control") || "";
    if (res.ok && !/\b(no-store|private)\b/i.test(policy)) cache.put(request, res.clone());
    return res;
  } catch {
    const exact = await cache.match(request, { ignoreSearch: true });
    if (exact) return exact;
    for (const shell of SHELL_FALLBACKS) {
      const hit = await cache.match(shell, { ignoreSearch: true });
      if (hit) return hit;
    }
    const fb = await caches.match("/offline.html");
    if (fb) return fb;
    return new Response("Hors ligne", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
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
    event.respondWith(navigationResponse(request));
  }
});
