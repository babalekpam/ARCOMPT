import { beforeAll, describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "@arcompt/ledger";
import { createApp } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const store = new MemoryStore();
const app = createApp({ quiet: true, auth: { mode: "dev" }, ledgerFor: () => new Ledger(store, { baseCurrency: "XOF" }) });
const headers = (tenant = TENANT) => ({ "content-type": "application/json", "x-user-id": "u1", "x-tenant-id": tenant });

beforeAll(async () => {
  for (const t of [TENANT, OTHER]) {
    store.seedAccounts(t, [
      { number: "411", label: "Clients", lettrable: false },
      { number: "706", label: "Services vendus" },
      { number: "443", label: "TVA facturée" },
      { number: "521", label: "Banques" },
      { number: "101", label: "Capital" },
    ]);
    store.seedJournals(t);
    await store.createFiscalYear(t, { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  }
});

describe("API", () => {
  it("expose /health sans authentification", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("refuse une requête sans contexte tenant", async () => {
    const res = await app.request("/v1/entries/trial-balance?fiscalYear=2025");
    expect(res.status).toBe(401);
  });

  it("crée, valide, contrepasse une écriture et renvoie la balance", async () => {
    const body = { journalCode: "VT", date: "2025-02-10", label: "Facture", lines: [{ accountNumber: "411", debit: "118" }, { accountNumber: "706", credit: "100" }, { accountNumber: "443", credit: "18" }] };
    const created = await app.request("/v1/entries", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const draft = await json(created);
    expect(draft.status).toBe("DRAFT");

    const validated = await json(await app.request(`/v1/entries/${draft.id}/validate`, { method: "POST", headers: headers() }));
    expect(validated.number).toBe(1);

    const tb = await json(await app.request("/v1/entries/trial-balance?fiscalYear=2025", { headers: headers() }));
    expect(tb.totalDebit).toBe("118.0000");

    const reversed = await app.request(`/v1/entries/${draft.id}/reverse`, { method: "POST", headers: headers(), body: JSON.stringify({ date: "2025-02-28" }) });
    expect(reversed.status).toBe(200);
    const again = await app.request(`/v1/entries/${draft.id}/reverse`, { method: "POST", headers: headers(), body: "{}" });
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("ALREADY_REVERSED");

    const chain = await json(await app.request("/v1/entries/chain/VT", { headers: headers() }));
    expect(chain).toEqual({ ok: true, checked: 2 });
  });

  it("renvoie 422 sur une écriture déséquilibrée et 400 sur un corps invalide", async () => {
    const bad = { journalCode: "VT", date: "2025-02-10", label: "x", lines: [{ accountNumber: "411", debit: "10" }, { accountNumber: "706", credit: "9" }] };
    const res = await app.request("/v1/entries", { method: "POST", headers: headers(), body: JSON.stringify(bad) });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("UNBALANCED");
    const res400 = await app.request("/v1/entries", { method: "POST", headers: headers(), body: JSON.stringify({ journalCode: "VT" }) });
    expect(res400.status).toBe(400);
  });

  it("ne laisse pas un autre dossier voir ou valider une écriture", async () => {
    const body = { journalCode: "OD", date: "2025-03-01", label: "Apport", lines: [{ accountNumber: "521", debit: "1000" }, { accountNumber: "101", credit: "1000" }] };
    const draft = await json(await app.request("/v1/entries", { method: "POST", headers: headers(), body: JSON.stringify(body) }));
    const res = await app.request(`/v1/entries/${draft.id}/validate`, { method: "POST", headers: headers(OTHER) });
    expect(res.status).toBe(404);
    const tb = await json(await app.request("/v1/entries/trial-balance?fiscalYear=2025", { headers: headers(OTHER) }));
    expect(tb.rows).toEqual([]);
  });

  it("produit les états financiers depuis le grand livre", async () => {
    const res = await app.request("/v1/statements?fiscalYear=2025", { headers: headers() });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.templateId).toBe("syscohada-revise");
    expect(out.statements.BILAN_ACTIF.byCode.BZ).toBeDefined();
    expect(out.controls.find((c: { id: string }) => c.id === "ACTIF_EGAL_PASSIF").ok).toBe(true);
  });

  it("liste les packs pays", async () => {
    const res = await app.request("/v1/packs", { headers: headers() });
    const out = await json(res);
    expect(out.packs.map((p: { code: string }) => p.code)).toContain("ci");
  });
});
