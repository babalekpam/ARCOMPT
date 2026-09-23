// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger, MemoryStore, Money } from "@arcompt/ledger";
import { balanceFromRows, computeStatements } from "@arcompt/statements";
import {
  closeBrowser,
  ledgerViewFromEntries,
  ledgerWorkbook,
  renderHtml,
  renderPdf,
  resolveChromiumPath,
  statementsWorkbook,
  trialBalanceView,
  trialBalanceWorkbook,
  type BankReconciliationView,
  type CompanyHeader,
  type InvoiceView,
  type PayslipView,
  DEFAULT_LOCALE,
  formatAmount,
  formatDate,
  formatMoney,
  formatPercent,
  formatRateText,
  formatSide,
  normalizeLocale,
  noteOutlineEn,
  noteRowEn,
  noteTitleGloss,
  resolveLocale,
  statementLineGloss,
} from "./index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "balances", "demo-ci");
interface Fixture {
  rows: Array<{ account: string; label: string; debit: string; credit: string }>;
}
const load = (file: string): Fixture => JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Fixture;

const company: CompanyHeader = {
  name: "DEMO CI SARL",
  legalForm: "SARL",
  capital: "5000000",
  identifiers: [
    { label: "NCC", value: "1234567 A" },
    { label: "RCCM", value: "CI-ABJ-2020-B-12345" },
  ],
  address: "Cocody, Rue des Jardins",
  city: "Abidjan",
  country: "Côte d'Ivoire",
};

const output = computeStatements({
  system: "NORMAL",
  currency: "XOF",
  fiscalYearCode: "2025",
  balance: balanceFromRows(load("balance-2025.json").rows),
  previousBalance: balanceFromRows(load("balance-2024.json").rows),
});

afterAll(async () => {
  await closeBrowser();
});

describe("états financiers (HTML)", () => {
  const html = renderHtml("statements", output, { company, generatedAt: "2026-01-15T10:00:00Z" });

  it("présente l'en-tête officiel : société, identifiants, exercice, devise, système", () => {
    expect(html).toContain("DEMO CI SARL");
    expect(html).toContain("1234567 A");
    expect(html).toContain("CI-ABJ-2020-B-12345");
    expect(html).toContain("Système normal");
    expect(html).toContain("<b>2025</b>");
    expect(html).toContain("Montants en <b>XOF</b>");
    expect(html).toContain("Capital 5\u00a0000\u00a0000\u00a0XOF");
  });

  it("rend les quatre états avec leurs colonnes et leurs totaux", () => {
    expect(html).toContain("Bilan – Actif");
    expect(html).toContain("<th>Brut</th><th>Amort. / Dépréc.</th><th>Net</th><th>Net N-1</th>");
    expect(html).toContain("Bilan – Passif");
    expect(html).toContain("Compte de résultat");
    expect(html).toContain("Tableau des flux de trésorerie");
    // TOTAL GÉNÉRAL du bilan : 9 164 000 en N, 8 200 000 en N-1.
    expect(html).toMatch(/<tr class="total"><td class="code">BZ<\/td><td>TOTAL GÉNÉRAL<\/td><td class="note"><\/td>.*?<td class="num">9\u00a0164\u00a0000<\/td><td class="num">8\u00a0200\u00a0000<\/td><\/tr>/s);
    expect(html).toMatch(/DZ<\/td><td>TOTAL GÉNÉRAL<\/td><td class="note"><\/td><td class="num">9\u00a0164\u00a0000<\/td>/);
    // Compte de résultat : charges en négatif avec le signe « − », soldes intermédiaires stylés.
    expect(html).toContain('<tr class="subtotal"><td class="code">XB</td><td>CHIFFRE D&#39;AFFAIRES</td><td class="note"></td><td class="num">6\u00a0000\u00a0000</td><td class="num">4\u00a0000\u00a0000</td></tr>');
    expect(html).toContain('<td class="num neg">−2\u00a0000\u00a0000</td>');
    expect(html).toContain('<tr class="total"><td class="code">XI</td><td>RÉSULTAT NET</td><td class="note"></td><td class="num">550\u00a0000</td><td class="num">1\u00a0200\u00a0000</td></tr>');
    // TFT
    expect(html).toContain('ZG</td><td>VARIATION DE LA TRÉSORERIE NETTE DE LA PÉRIODE</td><td class="num neg">−316\u00a0000</td>');
    // Actif en paysage, autres en portrait.
    expect(html).toContain('<section class="page landscape">');
    expect(html).toContain("@page landscape { size: A4 landscape; }");
  });

  it("rend chaque note avec ses lignes et son rapprochement, et les notes narratives en brouillon", () => {
    expect(html).toContain("Note 7 – Clients");
    expect(html).toMatch(/Note 7 – Clients<\/h2>[\s\S]*?<td class="num">1\u00a0180\u00a0000<\/td>/);
    expect(html).toContain('Rapprochement avec le poste <b>BI</b> (Bilan – Actif – Clients)\u00a0: <span class="badge ok">OK</span>');
    expect(html).toContain("Note 2 – Informations obligatoires");
    expect((html.match(/BROUILLON À VALIDER/g) ?? []).length).toBe(output.notes.filter((n) => n.status === "DRAFT_REQUIRED").length);
    expect(html).toContain("Méthodes d&#39;évaluation des stocks");
  });

  it("rend la page de contrôles avec sévérité et résultat", () => {
    expect(html).toContain("Contrôles de cohérence");
    expect(html).toContain("États publiables");
    expect(html).toContain('<td class="code">ACTIF_EGAL_PASSIF</td>');
    expect(html).toContain('<span class="badge blocking">Bloquant</span>');
    expect(html).toContain('<span class="badge ok">OK</span>');
  });

  it("marque un contrôle KO et le filigrane quand les états ne sont pas publiables", () => {
    const broken = computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows([{ account: "521", label: "", debit: "10", credit: "0" }]) });
    const h = renderHtml("statements", broken, { watermark: "BROUILLON" });
    expect(h).toContain("États non publiables");
    expect(h).toContain('<span class="badge ko">KO</span>');
    expect(h).toContain('<div class="watermark">BROUILLON</div>');
  });

  it("traduit les intitulés principaux en anglais", () => {
    const en = renderHtml("statements", output, { locale: "en", company });
    expect(en).toContain("Balance sheet – Assets");
    expect(en).toContain("Income statement");
    expect(en).toContain("Normal system");
    expect(en).toContain("DRAFT – TO BE VALIDATED");
    expect(en).toContain("Consistency checks");
    // L'intitulé officiel français reste imprimé sous le titre traduit : c'est lui
    // qui identifie le formulaire devant l'administration.
    expect(en).toContain("Official SYSCOHADA caption: Bilan – Actif");
    // …et les postes gardent leur libellé réglementaire, glosé en anglais.
    expect(en).toContain('TOTAL ACTIF IMMOBILISÉ <span class="gloss">Total non-current assets</span>');
  });

  it("échappe le HTML des données", () => {
    const h = renderHtml("statements", output, { company: { name: "<script>alert(1)</script>" } });
    expect(h).not.toContain("<script>alert");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("marque ARCOMPT dans les documents", () => {
  const h = renderHtml("statements", output, { company, generatedAt: "2026-01-15T10:00:00Z" });

  it("place la marque au pied de page, comme logiciel producteur", () => {
    // Image embarquée en data URI : ces gabarits sont rendus par un Chromium
    // sans réseau, aucune requête ne doit partir au moment de l'impression.
    expect(h).toContain('<span class="producer"><img class="mark" alt="" src="data:image/png;base64,');
    expect(h).toContain("ARCOMPT</span>");
    // Le logo fourni est matriciel : il porte ses couleurs et ne peut plus
    // hériter du gris du pied de page. On vérifie donc qu'il reste calibré à
    // 7 pt, la seule chose qui garantisse qu'il ne mange pas la ligne.
    expect(h).toContain(".doc-footer .producer .mark { width: 7pt; height: 7pt;");
    expect(h).not.toContain("fill: currentColor;");
  });

  it("ne se substitue pas à l'identité du client, qui reste seule en en-tête", () => {
    expect(h).toContain("DEMO CI SARL");
    expect(h.slice(0, h.indexOf('<footer class="doc-footer"'))).not.toContain('class="mark"');
  });

  it("n'apparaît qu'une fois par pied de page", () => {
    const footers = h.split('<footer class="doc-footer"').length - 1;
    expect(footers).toBeGreaterThan(1); // les états financiers font plusieurs pages
    expect(h.split('class="mark"').length - 1).toBe(footers);
  });
});

describe("PDF (Chromium)", () => {
  let chromium: string | null = null;
  try {
    chromium = resolveChromiumPath();
  } catch {
    chromium = null;
  }

  it.skipIf(!chromium)("génère un vrai PDF des états financiers", async (ctx) => {
    const html = renderHtml("statements", output, { company });
    let pdf: Buffer;
    try {
      pdf = await renderPdf(html);
    } catch (err) {
      console.warn(`Test PDF ignoré : Chromium impossible à lancer (${chromium}) : ${(err as Error).message.split("\n")[0]}`);
      ctx.skip();
      return;
    }
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(10 * 1024);
    // Le navigateur est partagé : un second rendu réutilise l'instance.
    const again = await renderPdf(renderHtml("trial-balance", trialBalanceView({ tenantId: "t", currency: "XOF", fiscalYearCode: "2025", from: "2025-01-01", to: "2025-12-31", rows: [], totalDebit: Money.zero(), totalCredit: Money.zero() }, "XOF")), { landscape: true, pageNumbers: false });
    expect(again.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("explique clairement l'absence de Chromium", () => {
    const saved = process.env.CHROMIUM_PATH;
    process.env.CHROMIUM_PATH = "/nonexistent/chromium";
    try {
      // Soit le navigateur enregistré par Playwright existe, soit l'erreur nomme les chemins essayés.
      let path: string | null = null;
      try {
        path = resolveChromiumPath();
      } catch (err) {
        expect((err as Error).message).toContain("/nonexistent/chromium");
        expect((err as Error).message).toContain("CHROMIUM_PATH");
      }
      if (path) expect(path).not.toBe("/nonexistent/chromium");
    } finally {
      if (saved === undefined) delete process.env.CHROMIUM_PATH;
      else process.env.CHROMIUM_PATH = saved;
    }
  });
});

async function readWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

function findRow(ws: ExcelJS.Worksheet, col: number, value: string): ExcelJS.Row | undefined {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((row) => {
    if (!found && row.getCell(col).value === value) found = row;
  });
  return found;
}

describe("Excel", () => {
  it("classeur des états : six feuilles, montants numériques et formats par devise", async () => {
    const buf = await statementsWorkbook(output, { company });
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const wb = await readWorkbook(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Bilan actif", "Bilan passif", "Compte de résultat", "TFT", "Notes", "Contrôles"]);

    const actif = wb.getWorksheet("Bilan actif")!;
    const bz = findRow(actif, 1, "BZ")!;
    expect(bz.getCell(2).value).toBe("TOTAL GÉNÉRAL");
    expect(bz.getCell(6).value).toBe(9164000);
    expect(bz.getCell(7).value).toBe(8200000);
    expect(bz.getCell(6).numFmt).toBe("#,##0;[Red]-#,##0");
    const am = findRow(actif, 1, "AM")!;
    expect([am.getCell(4).value, am.getCell(5).value, am.getCell(6).value]).toEqual([2800000, 800000, 2000000]);

    const cr = wb.getWorksheet("Compte de résultat")!;
    expect(findRow(cr, 1, "XI")!.getCell(4).value).toBe(550000);
    expect(findRow(cr, 1, "RA")!.getCell(4).value).toBe(-2000000);

    const notes = wb.getWorksheet("Notes")!;
    expect(findRow(notes, 1, "Note 7")!.getCell(2).value).toBe("Clients");
    expect(findRow(notes, 2, "BROUILLON À VALIDER")).toBeDefined();

    const controls = wb.getWorksheet("Contrôles")!;
    expect(findRow(controls, 1, "ACTIF_EGAL_PASSIF")!.getCell(4).value).toBe("OK");
  });

  it("conserve quatre décimales et le format à deux décimales pour l'euro", async () => {
    const view = trialBalanceView(
      { tenantId: "t", currency: "EUR", fiscalYearCode: "2025", from: "2025-01-01", to: "2025-12-31", rows: [{ accountNumber: "521", label: "Banque", class: 5, debit: Money.parse("1234.5678"), credit: Money.zero() }], totalDebit: Money.parse("1234.5678"), totalCredit: Money.zero() },
      "EUR",
    );
    const wb = await readWorkbook(await trialBalanceWorkbook(view));
    const row = findRow(wb.getWorksheet("Balance")!, 1, "521")!;
    expect(row.getCell(3).value).toBe(1234.5678);
    expect(row.getCell(3).numFmt).toBe("#,##0.00;[Red]-#,##0.00");
  });
});

describe("balance générale et grand livre", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const actor = { userId: "u1", tenantId: TENANT };

  async function seed() {
    const store = new MemoryStore();
    store.seedAccounts(TENANT, [
      { number: "101", label: "Capital social" },
      { number: "411", label: "Clients", lettrable: true },
      { number: "443", label: "TVA facturée" },
      { number: "521", label: "Banques locales" },
      { number: "706", label: "Services vendus" },
    ]);
    store.seedJournals(TENANT);
    await store.createFiscalYear(TENANT, { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
    const ledger = new Ledger(store, { baseCurrency: "XOF" });
    await ledger.post(actor, { journalCode: "OD", date: "2025-01-02", label: "Apport en capital", source: "MANUAL", lines: [{ accountNumber: "521", debit: "1000000" }, { accountNumber: "101", credit: "1000000" }] });
    await ledger.post(actor, { journalCode: "VT", date: "2025-03-15", reference: "FAC-001", label: "Facture client", source: "INVOICE", lines: [{ accountNumber: "411", debit: "118000", partnerId: "p1", label: "Client A" }, { accountNumber: "706", credit: "100000" }, { accountNumber: "443", credit: "18000" }] });
    await ledger.post(actor, { journalCode: "BQ", date: "2025-04-01", reference: "VIR-7", label: "Règlement client", source: "BANK", lines: [{ accountNumber: "521", debit: "118000" }, { accountNumber: "411", credit: "118000", partnerId: "p1" }] });
    return ledger;
  }

  it("balance : sous-totaux par classe, soldes débiteurs/créditeurs, total général", async () => {
    const ledger = await seed();
    const tb = await ledger.trialBalance(TENANT, { fiscalYearCode: "2025" });
    const html = renderHtml("trial-balance", trialBalanceView(tb, "XOF"), { company });
    expect(html).toContain("Balance générale");
    expect(html).toContain("du 01/01/2025 au 31/12/2025");
    expect(html).toContain('<td class="code">521</td><td>Banques locales</td><td class="num">1\u00a0118\u00a0000</td><td class="num">–</td><td class="num">1\u00a0118\u00a0000</td><td class="num">–</td>');
    expect(html).toContain("Total classe 4");
    expect(html).toMatch(/TOTAL GÉNÉRAL<\/td><td class="num">1\u00a0236\u00a0000<\/td><td class="num">1\u00a0236\u00a0000<\/td><td class="num">1\u00a0118\u00a0000<\/td><td class="num">1\u00a0118\u00a0000<\/td>/);

    const wb = await readWorkbook(await trialBalanceWorkbook(trialBalanceView(tb, "XOF")));
    expect(findRow(wb.getWorksheet("Balance")!, 1, "411")!.getCell(3).value).toBe(118000);
  });

  it("grand livre : écritures par compte avec solde progressif, filtre par compte", async () => {
    const ledger = await seed();
    const tb = await ledger.trialBalance(TENANT, { fiscalYearCode: "2025" });
    const labels = new Map(tb.rows.map((r) => [r.accountNumber, r.label]));
    const entries = await ledger.listEntries(TENANT, { fiscalYearCode: "2025" });
    const view = ledgerViewFromEntries(entries, { fiscalYearCode: "2025", from: tb.from, to: tb.to, currency: "XOF", accountLabels: labels });
    expect(view.accounts.map((a) => a.accountNumber)).toEqual(["101", "411", "443", "521", "706"]);
    const client = view.accounts.find((a) => a.accountNumber === "411")!;
    expect(client.balance.toString()).toBe("0.0000");
    expect(client.lines.map((l) => l.label)).toEqual(["Client A", "Règlement client"]);

    const html = renderHtml("ledger", view, { company });
    expect(html).toContain("Grand livre");
    expect(html).toContain("<h2>411 – Clients</h2>");
    expect(html).toContain('<td class="code">VT</td><td class="code">1</td><td>FAC-001</td><td>Client A</td><td class="num">118\u00a0000</td><td class="num">–</td><td class="num">118\u00a0000\u00a0D</td>');
    expect(html).toContain("Total du compte</td><td class=\"num\">1\u00a0118\u00a0000</td><td class=\"num\">–</td><td class=\"num\">1\u00a0118\u00a0000\u00a0D</td>");
    expect(html).toContain("1\u00a0000\u00a0000\u00a0C"); // capital : solde créditeur

    const only = ledgerViewFromEntries(await ledger.listEntries(TENANT, { fiscalYearCode: "2025", accountNumber: "52" }), { fiscalYearCode: "2025", from: tb.from, to: tb.to, currency: "XOF", accountNumber: "52" });
    expect(only.accounts.map((a) => a.accountNumber)).toEqual(["521"]);
    expect(only.accounts[0]!.lines).toHaveLength(2);

    const wb = await readWorkbook(await ledgerWorkbook(view));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Grand livre", "Soldes"]);
    expect(findRow(wb.getWorksheet("Soldes")!, 1, "521")!.getCell(5).value).toBe(1118000);
  });
});

describe("facture, bulletin, rapprochement", () => {
  it("facture : mentions légales, lignes HT/TVA/TTC, certification, mobile money", () => {
    const inv: InvoiceView = {
      number: "FAC-2025-0042",
      issueDate: "2025-09-01",
      dueDate: "2025-09-30",
      currency: "XOF",
      seller: { name: "DEMO CI SARL", identifiers: [{ label: "NCC", value: "1234567 A" }] },
      buyer: { name: "Client & Fils", identifiers: [{ label: "NCC", value: "7654321 B" }], address: "Plateau", city: "Abidjan", country: "Côte d'Ivoire" },
      lines: [
        { description: "Prestation de conseil", quantity: "2", unit: "jour", unitPrice: "150000", vatRate: "18", totalHt: "300000", vatAmount: "54000", totalTtc: "354000" },
        { description: "Frais de déplacement", quantity: "1", unitPrice: "25000", vatRate: "0", totalHt: "25000", vatAmount: "0", totalTtc: "25000" },
      ],
      totalHt: "325000",
      totalVat: "54000",
      totalTtc: "379000",
      certification: { system: "FNE", reference: "FNE-2025-ABC123", qrData: "https://fne.example/verify/ABC123", verifyUrl: "https://fne.example/verify/ABC123" },
      payment: {
        terms: "Paiement à 30 jours",
        bank: { bankName: "SGCI", rib: "CI93 SG001 01234 56789012345 67" },
        mobileMoney: [
          { operator: "Orange Money", number: "+225 07 00 00 00 00", holder: "DEMO CI" },
          { operator: "Wave", number: "+225 05 00 00 00 00" },
        ],
      },
      legalMentions: ["Pénalités de retard : 3 fois le taux d'intérêt légal.", "Escompte pour paiement anticipé : néant."],
    };
    const html = renderHtml("invoice", inv, { company });
    expect(html).toContain("FACTURE N° FAC-2025-0042");
    expect(html).toContain("01/09/2025");
    expect(html).toContain("Client &amp; Fils");
    expect(html).toContain("7654321 B");
    expect(html).toContain('<td>Prestation de conseil</td><td class="num">2</td><td class="center">jour</td><td class="num">150\u00a0000</td><td class="num"></td><td class="num">18\u00a0%</td><td class="num">300\u00a0000</td><td class="num">54\u00a0000</td><td class="num">354\u00a0000</td>');
    expect(html).toContain("Net à payer\u00a0: 379\u00a0000\u00a0XOF");
    expect(html).toMatch(/<td class="center">0\u00a0%<\/td><td class="num">25\u00a0000<\/td><td class="num">0<\/td>/); // récapitulatif TVA calculé
    expect(html).toContain("FNE-2025-ABC123");
    expect(html).toContain('<div class="qr">QR<br>https://fne.example/verify/ABC123</div>');
    expect(html).toContain("Orange Money +225 07 00 00 00 00 (DEMO CI)");
    expect(html).toContain("Wave +225 05 00 00 00 00");
    expect(html).toContain("RIB CI93 SG001 01234 56789012345 67");
    expect(html).toContain("Pénalités de retard");
    expect(html).toContain('<span class="producer"><img class="mark"'); // logiciel producteur, sous les mentions du vendeur
    expect(renderHtml("invoice", { ...inv, kind: "CREDIT_NOTE" })).toContain("AVOIR N° FAC-2025-0042");
    expect(renderHtml("invoice", inv, { locale: "en" })).toContain("INVOICE No. FAC-2025-0042");
  });

  it("bulletin de paie : brut, cotisations salarié/employeur, ITS, net, coût employeur", () => {
    const slip: PayslipView = {
      employee: { fullName: "Kouassi Aya", employeeNumber: "E-014", jobTitle: "Comptable", category: "Cadre", hireDate: "2022-02-01", socialSecurityNumber: "CNPS 123456" },
      period: { start: "2025-09-01", end: "2025-09-30", label: "Septembre 2025" },
      currency: "XOF",
      paymentDate: "2025-09-30",
      paymentMode: "Virement",
      earnings: [
        { label: "Salaire de base", base: "500000", rate: "1", amount: "500000" },
        { label: "Prime de transport imposable", amount: "30000" },
      ],
      grossPay: "530000",
      contributions: [
        { label: "CNPS retraite", base: "530000", employeeRate: "6,3 %", employeeAmount: "33390", employerRate: "7,7 %", employerAmount: "40810" },
        { label: "CNPS prestations familiales", base: "70000", employeeAmount: "0", employerRate: "5,75 %", employerAmount: "4025" },
      ],
      totalEmployeeContributions: "33390",
      totalEmployerContributions: "44835",
      incomeTax: [{ label: "ITS", base: "496610", amount: "42000" }],
      netPay: "454610",
      employerCost: "574835",
      cumulative: { grossPay: "4770000", netPay: "4091490", incomeTax: "378000" },
      leaveBalanceDays: "12.5",
    };
    const html = renderHtml("payslip", slip, { company });
    expect(html).toContain("BULLETIN DE PAIE");
    expect(html).toContain("Kouassi Aya");
    expect(html).toContain("E-014");
    expect(html).toContain("Septembre 2025");
    expect(html).toContain("CNPS 123456");
    expect(html).toContain('SALAIRE BRUT</td><td class="num">530\u00a0000</td>');
    expect(html).toContain('<td>CNPS retraite</td><td class="num">530\u00a0000</td><td class="num">6,3\u00a0%</td><td class="num">33\u00a0390</td><td class="num">7,7\u00a0%</td><td class="num">40\u00a0810</td>');
    expect(html).toContain('Total cotisations</td><td class="num">33\u00a0390</td><td></td><td class="num">44\u00a0835</td>');
    expect(html).toContain('<td>ITS</td><td class="num">496\u00a0610</td><td class="num"></td><td class="num">42\u00a0000</td>');
    expect(html).toContain("NET À PAYER\u00a0: 454\u00a0610\u00a0XOF");
    expect(html).toContain("Coût total employeur\u00a0: <b>574\u00a0835\u00a0XOF</b>");
    expect(html).toContain("Solde de congés (jours)\u00a0: 12,5");
    expect(renderHtml("payslip", slip, { locale: "en" })).toContain("NET PAY: XOF\u00a0454,610");
  });

  it("rapprochement bancaire : soldes, suspens des deux côtés, écart", () => {
    const rec: BankReconciliationView = {
      bankAccount: { label: "Compte courant SGCI", ledgerAccount: "521100", bankName: "SGCI" },
      period: { start: "2025-09-01", end: "2025-09-30" },
      currency: "XOF",
      statementBalance: "1500000",
      ledgerBalance: "1430000",
      ledgerOnly: [{ date: "2025-09-29", label: "Chèque n° 118 fournisseur", reference: "CHQ118", amount: "-80000" }],
      bankOnly: [{ date: "2025-09-30", label: "Frais de tenue de compte", amount: "-10000" }],
      adjustedStatementBalance: "1420000",
      adjustedLedgerBalance: "1420000",
      matchedCount: 14,
    };
    const html = renderHtml("bank-reconciliation", rec, { company });
    expect(html).toContain("État de rapprochement bancaire");
    expect(html).toContain("Compte courant SGCI");
    expect(html).toContain('Solde du relevé bancaire 30/09/2025</td><td class="num">1\u00a0500\u00a0000</td>');
    expect(html).toContain("Chèque n° 118 fournisseur");
    expect(html).toContain('<td class="num neg">−80\u00a0000</td>');
    expect(html).toContain('<span class="badge ok">Rapprochement équilibré</span>');
    expect(html).toContain("Opérations lettrées\u00a0: 14");
    const ko = renderHtml("bank-reconciliation", { ...rec, adjustedLedgerBalance: "1400000" });
    expect(ko).toContain("Écart à expliquer");
    expect(ko).toContain('<td class="num">20\u00a0000</td>');
  });
});

// ---------------------------------------------------------------------------
// Bilinguisme
// ---------------------------------------------------------------------------

describe("d'où vient la langue d'un document", () => {
  it("suit la précédence demande → destinataire → dossier → opérateur → français", () => {
    // Le client anglophone l'emporte sur le comptable francophone.
    expect(resolveLocale({ recipient: "en", company: "fr", user: "fr" })).toBe("en");
    // Sans destinataire (balance, grand livre), c'est la langue du dossier.
    expect(resolveLocale({ company: "en", user: "fr" })).toBe("en");
    // L'opérateur ne tranche que si le dossier ne dit rien.
    expect(resolveLocale({ user: "en" })).toBe("en");
    // Une demande explicite passe avant tout le reste.
    expect(resolveLocale({ requested: "fr", recipient: "en", company: "en", user: "en" })).toBe("fr");
    // Défaut explicite, jamais celui du serveur.
    expect(resolveLocale({})).toBe("fr");
    expect(DEFAULT_LOCALE).toBe("fr");
  });

  it("saute une source absente, vide ou dans une langue non gérée", () => {
    expect(resolveLocale({ recipient: null, company: undefined, user: "en" })).toBe("en");
    expect(resolveLocale({ recipient: "", company: "en" })).toBe("en");
    expect(resolveLocale({ recipient: "de", company: "en" })).toBe("en");
    expect(resolveLocale({ recipient: "de" })).toBe("fr");
  });

  it("accepte les étiquettes régionales", () => {
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("FR_fr")).toBe("fr");
    expect(normalizeLocale("fr-CI")).toBe("fr");
    expect(normalizeLocale("de-DE")).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });
});

describe("mise en forme par langue", () => {
  it("sépare les milliers et les décimales à la française ou à l'anglaise", () => {
    // XOF n'a pas de décimale, EUR en a deux : cela vient de la devise, pas de la langue.
    expect(formatAmount("1234567", "XOF", "fr")).toBe("1\u00a0234\u00a0567");
    expect(formatAmount("1234567", "XOF", "en")).toBe("1,234,567");
    expect(formatAmount("1234.5", "EUR", "fr")).toBe("1\u00a0234,50");
    expect(formatAmount("1234.5", "EUR", "en")).toBe("1,234.50");
  });

  it("place le code devise après le montant en français, avant en anglais", () => {
    expect(formatMoney("1234.5", "EUR", "fr")).toBe("1\u00a0234,50\u00a0EUR");
    expect(formatMoney("1234.5", "EUR", "en")).toBe("EUR\u00a01,234.50");
  });

  it("écrit les dates sans ambiguïté dans les deux langues", () => {
    expect(formatDate("2025-03-15", "fr")).toBe("15/03/2025");
    // Ni 15/03 ni 03/15 : le mois en lettres, lisible partout.
    expect(formatDate("2025-03-15", "en")).toBe("15 Mar 2025");
    expect(formatDate("2025-12-01", "en")).toBe("1 Dec 2025");
    expect(formatDate(null, "en")).toBe("");
  });

  it("espace le pourcentage selon la langue et respecte les taux non numériques", () => {
    expect(formatPercent("18", "fr")).toBe("18\u00a0%");
    expect(formatPercent("18", "en")).toBe("18%");
    expect(formatRateText("6,3 %", "en")).toBe("6.3%");
    expect(formatRateText("6.3 %", "fr")).toBe("6,3\u00a0%");
    expect(formatRateText("forfait", "en")).toBe("forfait");
    expect(formatRateText(undefined, "en")).toBe("");
  });

  it("nomme le sens du solde comme l'écrit chaque langue", () => {
    expect(formatSide("1234", "XOF", "fr")).toBe("1\u00a0234\u00a0D");
    expect(formatSide("-1234", "XOF", "fr")).toBe("1\u00a0234\u00a0C");
    expect(formatSide("1234", "XOF", "en")).toBe("1,234\u00a0Dr");
    expect(formatSide("-1234", "XOF", "en")).toBe("1,234\u00a0Cr");
  });
});

describe("documents en anglais", () => {
  it("facture : libellés, montants, dates et deux-points anglais, devise devant", () => {
    const inv: InvoiceView = {
      number: "INV-2025-0007",
      issueDate: "2025-09-01",
      dueDate: "2025-10-01",
      currency: "EUR",
      seller: { name: "DEMO CI SARL" },
      buyer: { name: "Acme Trading Ltd", country: "Ghana" },
      lines: [{ description: "Advisory services", quantity: "2", unit: "day", unitPrice: "1500", vatRate: "18", totalHt: "3000", vatAmount: "540", totalTtc: "3540" }],
      totalHt: "3000",
      totalVat: "540",
      totalTtc: "3540",
    };
    const en = renderHtml("invoice", inv, { locale: "en" });
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("INVOICE No. INV-2025-0007");
    expect(en).toContain("Issue date: <b>1 Sep 2025</b>");
    expect(en).toContain("Due date: <b>1 Oct 2025</b>");
    expect(en).toContain("Bill to");
    expect(en).toContain('<td class="num">18%</td>');
    expect(en).toContain('<td class="num">3,000.00</td>');
    expect(en).toContain("Amount due: EUR\u00a03,540.00");
    // Rien de français ne doit subsister.
    expect(en).not.toContain("FACTURE");
    expect(en).not.toContain("Net à payer");
    expect(en).not.toContain("01/09/2025");

    const fr = renderHtml("invoice", inv, { locale: "fr" });
    expect(fr).toContain("Net à payer\u00a0: 3\u00a0540,00\u00a0EUR");
    expect(fr).toContain("Date d&#39;émission\u00a0: <b>01/09/2025</b>");
  });

  it("états financiers : titre traduit, intitulé officiel français conservé, postes glosés", () => {
    const en = renderHtml("statements", output, { locale: "en", company });
    expect(en).toContain("<h1>Balance sheet – Assets</h1>");
    expect(en).toContain("Official SYSCOHADA caption: Bilan – Actif");
    expect(en).toContain('CHIFFRE D&#39;AFFAIRES <span class="gloss">Revenue</span>');
    expect(en).toContain('RÉSULTAT NET <span class="gloss">Net profit or loss</span>');
    expect(en).toContain("Current year");
    expect(en).toContain("Prior year");
    expect(en).toContain("Generated on");
    // Le français n'ajoute aucune glose.
    const fr = renderHtml("statements", output, { locale: "fr", company });
    expect(fr).not.toContain('class="gloss"');
    expect(fr).not.toContain("Official SYSCOHADA caption");
  });

  it("chaque poste du référentiel a sa glose anglaise", () => {
    for (const st of Object.values(output.statements)) {
      for (const line of st?.lines ?? []) expect(statementLineGloss(line.code), `poste ${line.code} sans glose`).toBeTypeOf("string");
    }
  });

  it("chaque note a son titre anglais, et chaque trame de rédaction sa version anglaise", () => {
    // Garde-fou de complétude : une note ajoutée au référentiel sans son
    // anglais laisserait un bloc français au milieu d'un document anglais.
    for (const note of output.notes) {
      expect(noteTitleGloss(note.number), `note ${note.number} sans titre anglais`).toBeTypeOf("string");
      if ((note.outline?.length ?? 0) > 0) {
        expect(noteOutlineEn(note.number), `note ${note.number} sans trame anglaise`).toBeDefined();
      }
    }
  });

  it("chaque ligne de note calculée a sa traduction anglaise", () => {
    // Même garde-fou, sur les lignes : c'est là que le français passait
    // inaperçu, parce qu'une note anglaise avec un titre anglais et des lignes
    // françaises a l'air traduite au premier coup d'œil.
    for (const note of output.notes) {
      for (const row of note.rows) {
        expect(noteRowEn(row.label), `ligne « ${row.label} » (note ${note.number}) sans traduction anglaise`).toBeTypeOf("string");
      }
    }
  });

  it("chaque contrôle de cohérence a son libellé et son détail anglais", () => {
    // La page des contrôles fermait la liasse anglaise en français : elle est
    // imprimée dans le document, pas seulement affichée à l'écran.
    for (const control of output.controls) {
      expect(control.labelEn, `contrôle ${control.id} sans libellé anglais`).toBeTypeOf("string");
      expect(control.detailEn, `contrôle ${control.id} sans détail anglais`).toBeTypeOf("string");
    }
  });

  it("une note anglaise ne laisse pas passer de libellé de ligne français", () => {
    const html = renderHtml("statements", output, { locale: "en", company: { name: "Alpha" } });
    // La comparaison porte sur la CELLULE entière : les mêmes mots existent
    // aussi comme intitulés de postes, où le français est conservé exprès et
    // suivi de sa glose (`… <span class="gloss">…`). Une cellule qui ne contient
    // que du français est, elle, une ligne de note non traduite.
    for (const note of output.notes) {
      for (const row of note.rows) {
        expect(html, `ligne « ${row.label} » restée en français`).not.toContain(`<td>${row.label}</td>`);
      }
    }
  });

  it("balance, grand livre et rapprochement : sens Dr/Cr, dates et séparateurs anglais", () => {
    const view = {
      fiscalYearCode: "2025",
      from: "2025-01-01",
      to: "2025-12-31",
      currency: "XOF",
      rows: [{ accountNumber: "411100", label: "Trade receivables", debit: "1234567", credit: "0" }],
      totalDebit: "1234567",
      totalCredit: "0",
    };
    const en = renderHtml("trial-balance", view, { locale: "en" });
    expect(en).toContain("Trial balance");
    expect(en).toContain("Account name");
    expect(en).toContain('<td class="num">1,234,567</td>');
    expect(en).toContain("from 1 Jan 2025 to 31 Dec 2025");
    expect(en).not.toContain("01/01/2025");
  });

  it("bulletin de paie : taux re-ponctués et mention de conservation en anglais", () => {
    const slip: PayslipView = {
      employee: { fullName: "Ama Mensah" },
      period: { start: "2025-09-01", end: "2025-09-30" },
      currency: "XOF",
      earnings: [{ label: "Basic salary", amount: "500000" }],
      grossPay: "500000",
      contributions: [{ label: "CNPS pension", base: "500000", employeeRate: "6,3 %", employeeAmount: "31500", employerRate: "7,7 %", employerAmount: "38500" }],
      totalEmployeeContributions: "31500",
      totalEmployerContributions: "38500",
      incomeTax: [{ label: "PAYE", base: "468500", amount: "40000" }],
      netPay: "428500",
      employerCost: "538500",
      leaveBalanceDays: "12.5",
    };
    const en = renderHtml("payslip", slip, { locale: "en" });
    expect(en).toContain("PAYSLIP");
    expect(en).toContain("Period: <b>1 Sep 2025 – 30 Sep 2025</b>");
    expect(en).toContain('<td class="num">6.3%</td>');
    expect(en).toContain("NET PAY: XOF\u00a0428,500");
    expect(en).toContain("Leave balance (days): 12.5");
    expect(en).toContain("Keep this payslip indefinitely.");
    expect(en).not.toContain("6,3");
  });
});
