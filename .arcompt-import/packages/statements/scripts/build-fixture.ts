// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Génère la balance de référence « demo-ci » (deux exercices) en passant par
 * le moteur comptable, puis l'écrit dans fixtures/balances/demo-ci/.
 *
 * Les valeurs attendues (expected.json) ont été vérifiées à la main ; toute
 * modification de gabarit doit continuer à les reproduire.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, MemoryStore, type Actor, type JournalEntryInput } from "@arcompt/ledger";
import { SYSCOHADA_CHART } from "@arcompt/db/chart";

const TENANT = "00000000-0000-4000-8000-00000000d3a0";
const actor: Actor = { userId: "fixture", tenantId: TENANT };

function accountsFromChart() {
  const numbers = SYSCOHADA_CHART.map((a) => a.number);
  return SYSCOHADA_CHART.map((a) => ({
    number: a.number,
    label: a.label,
    lettrable: false, // fixture : pas de tiers
    postable: !numbers.some((n) => n !== a.number && n.startsWith(a.number)),
  }));
}

const e = (journalCode: string, date: string, label: string, lines: Array<[string, string, string]>): JournalEntryInput => ({
  journalCode,
  date,
  label,
  source: "MANUAL",
  lines: lines.map(([accountNumber, debit, credit]) => ({ accountNumber, ...(debit !== "0" ? { debit } : {}), ...(credit !== "0" ? { credit } : {}) })),
});

export async function buildDemoBalances() {
  const store = new MemoryStore();
  store.seedAccounts(TENANT, accountsFromChart());
  store.seedJournals(TENANT);
  await store.createFiscalYear(TENANT, { code: "2024", startDate: "2024-01-01", endDate: "2024-12-31" });
  await store.createFiscalYear(TENANT, { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  const ledger = new Ledger(store, { baseCurrency: "XOF" });

  // ----- Exercice 2024 (N-1) : création, premier matériel, premières ventes -----
  const y2024: JournalEntryInput[] = [
    e("BQ", "2024-01-10", "Libération du capital", [["521", "5000000", "0"], ["101", "0", "5000000"]]),
    e("OD", "2024-02-01", "Achat matériel et mobilier", [["244", "3000000", "0"], ["481", "0", "3000000"]]),
    e("BQ", "2024-02-15", "Règlement fournisseur d'investissement", [["481", "3000000", "0"], ["521", "0", "3000000"]]),
    e("VT", "2024-06-30", "Prestations facturées", [["411", "4720000", "0"], ["706", "0", "4000000"], ["443", "0", "720000"]]),
    e("BQ", "2024-07-31", "Encaissement clients", [["521", "4720000", "0"], ["411", "0", "4720000"]]),
    e("AC", "2024-09-30", "Loyers", [["622", "1200000", "0"], ["445", "216000", "0"], ["401", "0", "1416000"]]),
    e("BQ", "2024-10-05", "Règlement loyers", [["401", "1416000", "0"], ["521", "0", "1416000"]]),
    e("PA", "2024-12-31", "Salaires", [["661", "1000000", "0"], ["422", "0", "1000000"]]),
    e("BQ", "2024-12-31", "Paiement salaires", [["422", "1000000", "0"], ["521", "0", "1000000"]]),
    e("OD", "2024-12-31", "Liquidation TVA", [["443", "720000", "0"], ["445", "0", "216000"], ["444", "0", "504000"]]),
    e("BQ", "2024-12-31", "Paiement TVA", [["444", "504000", "0"], ["521", "0", "504000"]]),
    e("OD", "2024-12-31", "Dotation aux amortissements", [["681", "600000", "0"], ["2844", "0", "600000"]]),
    e("BQ", "2024-12-20", "Emprunt bancaire", [["521", "2000000", "0"], ["162", "0", "2000000"]]),
  ];
  for (const input of y2024) await ledger.post(actor, input);
  const b2024 = await ledger.trialBalance(TENANT, { fiscalYearCode: "2024" });

  // ----- Exercice 2025 (N) : à-nouveaux, affectation, activité, cession, remboursement -----
  const y2025: JournalEntryInput[] = [
    e("AN", "2025-01-01", "À-nouveaux", [["244", "3000000", "0"], ["521", "5800000", "0"], ["2844", "0", "600000"], ["101", "0", "5000000"], ["162", "0", "2000000"], ["131", "0", "1200000"]]),
    e("OD", "2025-03-31", "Affectation du résultat 2024", [["131", "1200000", "0"], ["111", "0", "120000"], ["465", "0", "500000"], ["121", "0", "580000"]]),
    e("BQ", "2025-04-15", "Paiement des dividendes", [["465", "500000", "0"], ["521", "0", "500000"]]),
    e("VT", "2025-06-30", "Prestations facturées", [["411", "7080000", "0"], ["706", "0", "6000000"], ["443", "0", "1080000"]]),
    e("BQ", "2025-09-30", "Encaissement clients", [["521", "5900000", "0"], ["411", "0", "5900000"]]),
    e("AC", "2025-05-31", "Achats de marchandises", [["601", "2000000", "0"], ["445", "360000", "0"], ["401", "0", "2360000"]]),
    e("BQ", "2025-06-15", "Règlement partiel fournisseurs", [["401", "1500000", "0"], ["521", "0", "1500000"]]),
    e("OD", "2025-12-31", "Stock final de marchandises", [["311", "500000", "0"], ["6031", "0", "500000"]]),
    e("AC", "2025-09-30", "Loyers", [["622", "1200000", "0"], ["445", "216000", "0"], ["401", "0", "1416000"]]),
    e("BQ", "2025-10-05", "Règlement loyers", [["401", "1416000", "0"], ["521", "0", "1416000"]]),
    e("PA", "2025-12-31", "Salaires", [["661", "1500000", "0"], ["422", "0", "1500000"]]),
    e("BQ", "2025-12-31", "Paiement salaires", [["422", "1500000", "0"], ["521", "0", "1500000"]]),
    e("PA", "2025-12-31", "Charges sociales", [["664", "300000", "0"], ["431", "0", "300000"]]),
    e("BQ", "2025-12-31", "Paiement partiel charges sociales", [["431", "250000", "0"], ["521", "0", "250000"]]),
    e("OD", "2025-12-31", "Liquidation TVA", [["443", "1080000", "0"], ["445", "0", "576000"], ["444", "0", "504000"]]),
    e("BQ", "2025-12-31", "Paiement partiel TVA", [["444", "400000", "0"], ["521", "0", "400000"]]),
    e("OD", "2025-12-31", "Dotation aux amortissements", [["681", "600000", "0"], ["2844", "0", "600000"]]),
    e("OD", "2025-12-31", "Sortie du matériel cédé", [["812", "600000", "0"], ["2844", "400000", "0"], ["244", "0", "1000000"]]),
    e("BQ", "2025-12-31", "Prix de cession encaissé", [["521", "700000", "0"], ["822", "0", "700000"]]),
    e("BQ", "2025-11-30", "Remboursement d'emprunt", [["162", "400000", "0"], ["521", "0", "400000"]]),
    e("BQ", "2025-11-30", "Intérêts d'emprunt", [["671", "150000", "0"], ["521", "0", "150000"]]),
    e("BQ", "2025-08-01", "Acquisition matériel", [["244", "800000", "0"], ["521", "0", "800000"]]),
    e("OD", "2025-12-31", "Impôt sur le résultat", [["891", "300000", "0"], ["441", "0", "300000"]]),
  ];
  for (const input of y2025) await ledger.post(actor, input);
  const b2025 = await ledger.trialBalance(TENANT, { fiscalYearCode: "2025" });

  const toRows = (tb: typeof b2024) => tb.rows.map((r) => ({ account: r.accountNumber, label: r.label, debit: r.debit.toString(), credit: r.credit.toString() }));
  return { b2024: toRows(b2024), b2025: toRows(b2025) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "balances", "demo-ci");
  mkdirSync(dir, { recursive: true });
  const { b2024, b2025 } = await buildDemoBalances();
  writeFileSync(join(dir, "balance-2024.json"), JSON.stringify({ fiscalYear: "2024", currency: "XOF", system: "NORMAL", rows: b2024 }, null, 2) + "\n");
  writeFileSync(join(dir, "balance-2025.json"), JSON.stringify({ fiscalYear: "2025", currency: "XOF", system: "NORMAL", rows: b2025 }, null, 2) + "\n");
  console.log(`fixture écrite dans ${dir}`);
}
