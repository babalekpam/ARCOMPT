import { Hono } from "hono";
import type { Sql } from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginDraining, checkReadiness, readinessHandler, resetDraining } from "./health.js";

/**
 * La base est remplacée par un gabarit : `postgres` s'utilise comme fonction de
 * gabarit littéral (db`SELECT 1`), donc une fonction suffit à simuler une base
 * saine, en panne ou qui ne répond pas.
 */
const healthyDb = (() => Promise.resolve([{ "?column?": 1 }])) as unknown as Sql;
const failingDb = (() =>
  Promise.reject(new Error("connect ECONNREFUSED 10.1.2.3:5432 user=arcompt_app_login password=s3cret"))) as unknown as Sql;
const hangingDb = (() => new Promise(() => {})) as unknown as Sql;

afterEach(() => resetDraining());

describe("aptitude (/ready)", () => {
  it("répond 200 et signale la base debout quand l'aller-retour aboutit", async () => {
    const report = await checkReadiness({ db: healthyDb, timeoutMs: 50 });
    expect(report).toEqual({ ready: true, status: 200, dependencies: [{ name: "database", state: "up" }] });
  });

  it("répond 503 et signale la base à terre quand l'aller-retour échoue", async () => {
    const onFailure = vi.fn();
    const report = await checkReadiness({ db: failingDb, timeoutMs: 50, onFailure });
    expect(report).toEqual({ ready: false, status: 503, dependencies: [{ name: "database", state: "down" }] });
    // Le détail va aux journaux, jamais au client.
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]![0]).toBe("database");
  });

  it("borne la sonde : une base qui ne répond pas ne fait pas traîner la requête", async () => {
    const started = Date.now();
    const report = await checkReadiness({ db: hangingDb, timeoutMs: 20 });
    expect(report.ready).toBe(false);
    expect(report.dependencies).toEqual([{ name: "database", state: "down" }]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("agrège plusieurs dépendances et n'échoue que sur les requises", async () => {
    const report = await checkReadiness({
      db: healthyDb,
      timeoutMs: 50,
      probes: [
        { name: "queue", check: () => Promise.reject(new Error("redis down")), required: false },
        { name: "storage", check: () => Promise.resolve(true) },
      ],
    });
    expect(report.ready).toBe(true);
    expect(report.dependencies).toEqual([
      { name: "database", state: "up" },
      { name: "queue", state: "down" },
      { name: "storage", state: "up" },
    ]);
  });

  it("sans base configurée, la dépendance est déclarée non configurée", async () => {
    const report = await checkReadiness({ timeoutMs: 50 });
    expect(report).toEqual({ ready: true, status: 200, dependencies: [{ name: "database", state: "not_configured" }] });
  });

  it("sort de la rotation dès le début de l'arrêt, sans interroger les dépendances", async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    beginDraining();
    const report = await checkReadiness({ db: healthyDb, probes: [{ name: "queue", check: probe }] });
    expect(report).toEqual({ ready: false, status: 503, dependencies: [{ name: "process", state: "draining" }] });
    expect(probe).not.toHaveBeenCalled();
  });

  it("expose 200/503 en HTTP sans divulguer de détail interne", async () => {
    const app = new Hono();
    app.get("/ready", readinessHandler({ db: healthyDb, timeoutMs: 50 }));
    app.get("/ready-ko", readinessHandler({ db: failingDb, timeoutMs: 50 }));

    const ok = await app.request("/ready");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ ready: true, dependencies: [{ name: "database", state: "up" }] });

    const ko = await app.request("/ready-ko");
    expect(ko.status).toBe(503);
    const body = await ko.text();
    expect(JSON.parse(body)).toEqual({ ready: false, dependencies: [{ name: "database", state: "down" }] });
    expect(body).not.toMatch(/ECONNREFUSED|password|5432|arcompt_app_login/);
  });
});
