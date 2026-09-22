import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSecurityAlertSinks, onSecurityAlert, raiseSecurityAlert, webhookAlertSink, type SecurityAlert } from "./telemetry.js";

/**
 * Les signaux de sécurité (SECURITY.md §10.3) doivent quitter le processus :
 * tant qu'aucun puits n'est branché ils restent dans les journaux, ce qui ne
 * réveille personne. Ces tests vérifient le branchement, l'isolation des
 * pannes de puits et le format posté à l'astreinte.
 */
describe("alertes de sécurité", () => {
  afterEach(() => {
    clearSecurityAlertSinks();
    vi.unstubAllGlobals();
  });

  it("transmet l'alerte à chaque puits enregistré, horodatée", async () => {
    const seen: SecurityAlert[] = [];
    onSecurityAlert((a) => void seen.push(a));
    onSecurityAlert((a) => void seen.push(a));

    await raiseSecurityAlert({ signal: "rls.rejection", tenantId: "t1", detail: "GET /v1/entries" });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.signal).toBe("rls.rejection");
    expect(seen[0]?.tenantId).toBe("t1");
    expect(Date.parse(seen[0]?.at ?? "")).not.toBeNaN();
  });

  it("un puits en panne n'empêche ni les suivants ni la requête", async () => {
    const seen: string[] = [];
    onSecurityAlert(() => {
      throw new Error("astreinte injoignable");
    });
    onSecurityAlert((a) => void seen.push(a.signal));

    await expect(raiseSecurityAlert({ signal: "webhook.invalid_signature", detail: "x" })).resolves.toBeUndefined();
    expect(seen).toEqual(["webhook.invalid_signature"]);
  });

  it("le puits HTTP poste l'alerte en JSON et signale un refus du collecteur", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200 } as Response;
      }),
    );

    const sink = webhookAlertSink("https://astreinte.example/alertes");
    await sink({ signal: "auth.failure_burst", detail: "ip=10.0.0.1", at: "2026-09-22T10:00:00.000Z" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://astreinte.example/alertes");
    expect(calls[0]?.body).toMatchObject({ signal: "auth.failure_burst", detail: "ip=10.0.0.1" });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    await expect(webhookAlertSink("https://astreinte.example/alertes")({ signal: "rate.limited", detail: "k", at: "2026-09-22T10:00:00.000Z" })).rejects.toThrow("503");
  });

  it("expurge les secrets avant de quitter le processus", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        body = init.body;
        return { ok: true, status: 200 } as Response;
      }),
    );

    await webhookAlertSink("https://astreinte.example/alertes")({
      signal: "webhook.invalid_signature",
      detail: "rejet avec password=hunter2",
      at: "2026-09-22T10:00:00.000Z",
    });

    expect(body).not.toContain("hunter2");
  });
});
