// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Le service worker, exercé comme un navigateur le ferait : installation
 * (précache), coupure du réseau, navigations fraîches.
 *
 * Le cas qui compte est celui constaté en conditions réelles le 2026-10-29 :
 * un écran atteint par la navigation interne n'a pas de document conservé ;
 * son rechargement hors ligne doit servir la coquille de l'application,
 * pas la page statique « hors ligne » — qui n'est due que si AUCUN document
 * de l'application n'est sur l'appareil.
 */

const ORIGIN = "https://app.test";
const SW_SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

class FakeCache {
  private store = new Map<string, Response>();
  constructor(private fetchImpl: (input: string) => Promise<Response>) {}

  private key(input: string | { url: string }): string {
    const raw = typeof input === "string" ? input : input.url;
    return new URL(raw, ORIGIN).toString();
  }

  async add(input: string): Promise<void> {
    const res = await this.fetchImpl(input);
    if (!res.ok) throw new Error(`précache refusé : ${input}`);
    this.store.set(this.key(input), res.clone());
  }

  async addAll(inputs: string[]): Promise<void> {
    for (const input of inputs) await this.add(input);
  }

  async put(input: string | { url: string }, response: Response): Promise<void> {
    this.store.set(this.key(input), response.clone());
  }

  async match(input: string | { url: string }, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const wanted = new URL(this.key(input));
    for (const [key, res] of this.store) {
      const candidate = new URL(key);
      if (candidate.origin !== wanted.origin) continue;
      if (opts?.ignoreSearch ? candidate.pathname === wanted.pathname : candidate.toString() === wanted.toString()) return res.clone();
    }
    return undefined;
  }

  async delete(input: string | { url: string }): Promise<boolean> {
    return this.store.delete(this.key(input));
  }

  async keys(): Promise<Array<{ url: string }>> {
    return [...this.store.keys()].map((url) => ({ url }));
  }
}

interface Harness {
  navigate(path: string): Promise<Response>;
  pageCache(): Promise<FakeCache>;
  setOffline(off: boolean): void;
}

async function bootWorker(): Promise<Harness> {
  let offline = false;
  const fetchImpl = async (input: string | { url: string }): Promise<Response> => {
    if (offline) throw new TypeError("fetch failed");
    const path = new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname;
    // Comme en production : les écrans de l'application lisent les cookies
    // (langue, session), Next les sert donc « private, no-store ». C'est
    // cette politique qui, croisée avec la suppression dans l'ancien
    // navigationResponse, détruisait les documents précachés.
    return new Response(`DOC:${path}`, { status: 200, headers: { "cache-control": "private, no-cache, no-store", "content-type": "text/html" } });
  };
  const cachesByName = new Map<string, FakeCache>();
  const cacheStorage = {
    async open(name: string): Promise<FakeCache> {
      let cache = cachesByName.get(name);
      if (!cache) {
        cache = new FakeCache(fetchImpl);
        cachesByName.set(name, cache);
      }
      return cache;
    },
    async keys(): Promise<string[]> {
      return [...cachesByName.keys()];
    },
    async delete(name: string): Promise<boolean> {
      return cachesByName.delete(name);
    },
    async match(input: string | { url: string }, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
      for (const cache of cachesByName.values()) {
        const hit = await cache.match(input, opts);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const sandbox: Record<string, unknown> = {
    console,
    URL,
    Response,
    caches: cacheStorage,
    fetch: fetchImpl,
    location: { origin: ORIGIN },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
  };
  sandbox.self = sandbox;
  runInContext(SW_SOURCE, createContext(sandbox));

  // Installation : le précache se fait en ligne.
  let installDone: Promise<unknown> | undefined;
  const recordingEvent = {
    waitUntil: (p: Promise<unknown>) => {
      installDone = p;
    },
  };
  for (const cb of listeners.get("install") ?? []) cb(recordingEvent);
  await installDone;

  return {
    async navigate(path: string): Promise<Response> {
      let response: Promise<Response> | undefined;
      const event = {
        request: { url: `${ORIGIN}${path}`, method: "GET", mode: "navigate" },
        respondWith: (p: Promise<Response>) => {
          response = p;
        },
      };
      for (const cb of listeners.get("fetch") ?? []) cb(event);
      if (!response) throw new Error("le worker n'a pas répondu à la navigation");
      return response;
    },
    async pageCache(): Promise<FakeCache> {
      const names = await cacheStorage.keys();
      const pages = names.find((n) => n.startsWith("arcompt-pages-"));
      if (!pages) throw new Error("cache des pages introuvable");
      return cacheStorage.open(pages);
    },
    setOffline(off: boolean) {
      offline = off;
    },
  };
}

describe("service worker : navigations hors ligne", () => {
  it("sert le document exact quand il est conservé", async () => {
    const sw = await bootWorker();
    sw.setOffline(true);
    const res = await sw.navigate("/sync");
    expect(await res.text()).toBe("DOC:/sync");
  });

  it("une visite en ligne ne détruit pas le document précaché (politique « private, no-store »)", async () => {
    const sw = await bootWorker();
    // En ligne, l'utilisateur ouvre /sync par un vrai chargement de document
    // (pas par la navigation interne). La réponse fraîche est servie…
    const online = await sw.navigate("/sync");
    expect(await online.text()).toBe("DOC:/sync");
    // …mais elle ne doit pas chasser le document précaché à l'installation :
    // c'est lui le filet hors ligne. L'ancien worker le supprimait au nom de
    // la politique du serveur, et la navigation fraîche hors ligne vers
    // /sync tombait alors sur la coquille /dashboard — le tableau de bord
    // affiché à l'adresse /sync, constaté en e2e le 2026-10-29.
    sw.setOffline(true);
    const res = await sw.navigate("/sync");
    expect(await res.text()).toBe("DOC:/sync");
  });

  it("écran atteint par navigation interne (aucun document) : la coquille prend le relais, pas la page hors ligne", async () => {
    const sw = await bootWorker();
    // L'écran /sync n'a été atteint qu'en navigation interne : aucun
    // document ne le représente dans le cache. Il ne reste que la coquille.
    const pages = await sw.pageCache();
    await pages.delete("/sync");
    await pages.delete("/entries");
    await pages.delete("/entries/new");
    await pages.delete("/invoices/new");
    await pages.delete("/expenses/new");
    await pages.delete("/documents");
    await pages.delete("/accounts");
    sw.setOffline(true);
    const res = await sw.navigate("/sync");
    const body = await res.text();
    expect(body).toBe("DOC:/dashboard");
    expect(body).not.toBe("DOC:/offline.html");
  });

  it("le lancement de l'application installée (start_url /) s'ouvre hors ligne", async () => {
    const sw = await bootWorker();
    sw.setOffline(true);
    const res = await sw.navigate("/");
    expect(await res.text()).toBe("DOC:/");
  });

  it("page hors ligne statique seulement si aucun document de l'application n'est conservé", async () => {
    const sw = await bootWorker();
    const pages = await sw.pageCache();
    for (const key of await pages.keys()) await pages.delete(key.url);
    sw.setOffline(true);
    const res = await sw.navigate("/sync");
    expect(await res.text()).toBe("DOC:/offline.html");
  });
});
