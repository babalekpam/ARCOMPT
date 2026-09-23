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
    expect(html).toContain("Capital 5 000 000 XOF");
  });

  it("rend les quatre états avec leurs colonnes et leurs totaux", () => {
    expect(html).toContain("Bilan – Actif");
    expect(html).toContain("<th>Brut</th><th>Amort. / Dépréc.</th><th>Net</th><th>Net N-1</th>");
    expect(html).toContain("Bilan – Passif");
    expect(html).toContain("Compte de résultat");
    expect(html).toContain("Tableau des flux de trésorerie");
    // TOTAL GÉNÉRAL du bilan : 9 164 000 en N, 8 200 000 en N-1.
    expect(html).toMatch(/<tr class="total"><td class="code">BZ<\/td><td>TOTAL GÉNÉRAL<\/td><td class="note"><\/td>.*?<td class="num">9 164 000<\/td><td class="num">8 200 000<\/td><\/tr>/s);
    expect(html).toMatch(/DZ<\/td><td>TOTAL GÉNÉRAL<\/td><td class="note"><\/td><td class="num">9 164 000<\/td>/);
    // Compte de résultat : charges en négatif avec le signe « − », soldes intermédiaires stylés.
    expect(html).toContain('<tr class="subtotal"><td class="code">XB</td><td>CHIFFRE D&#39;AFFAIRES</td><td class="note"></td><td class="num">6 000 000</td><td class="num">4 000 000</td></tr>');
    expect(html).toContain('<td class="num neg">−2 000 000</td>');
    expect(html).toContain('<tr class="total"><td class="code">XI</td><td>RÉSULTAT NET</td><td class="note"></td><td class="num">550 000</td><td class="num">1 200 000</td></tr>');
    // TFT
    expect(html).toContain('ZG</td><td>VARIATION DE LA TRÉSORERIE NETTE DE LA PÉRIODE</td><td class="num neg">−316 000</td>');
    // Actif en paysage, autres en portrait.
    expect(html).toContain('<section class="page landscape">');
    expect(html).toContain("@page landscape { size: A4 landscape; }");
  });

  it("rend chaque note avec ses lignes et son rapprochement, et les notes narratives en brouillon", () => {
    expect(html).toContain("Note 7 – Clients");
    expect(html).toMatch(/Note 7 – Clients<\/h2>[\s\S]*?<td class="num">1 180 000<\/td>/);
    expect(html).toContain('Rapprochement avec le poste <b>BI</b> (Bilan – Actif – Clients) : <span class="badge ok">OK</span>');
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
    expect(en).not.toContain("Bilan – Actif");
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
    const again = await renderPdf(renderHtml("trial-balance", trialBalanceView({ tenantId: "t", fiscalYearCode: "2025", from: "2025-01-01", to: "2025-12-31", rows: [], totalDebit: Money.zero(), totalCredit: Money.zero() }, "XOF")), { landscape: true, pageNumbers: false });
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
      { tenantId: "t", fiscalYearCode: "2025", from: "2025-01-01", to: "2025-12-31", rows: [{ accountNumber: "521", label: "Banque", class: 5, debit: Money.parse("1234.5678"), credit: Money.zero() }], totalDebit: Money.parse("1234.5678"), totalCredit: Money.zero() },
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
    expect(html).toContain('<td class="code">521</td><td>Banques locales</td><td class="num">1 118 000</td><td class="num">–</td><td class="num">1 118 000</td><td class="num">–</td>');
    expect(html).toContain("Total classe 4");
    expect(html).toMatch(/TOTAL GÉNÉRAL<\/td><td class="num">1 236 000<\/td><td class="num">1 236 000<\/td><td class="num">1 118 000<\/td><td class="num">1 118 000<\/td>/);

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
    expect(html).toContain('<td class="code">VT</td><td class="code">1</td><td>FAC-001</td><td>Client A</td><td class="num">118 000</td><td class="num">–</td><td class="num">118 000 D</td>');
    expect(html).toContain("Total du compte</td><td class=\"num\">1 118 000</td><td class=\"num\">–</td><td class=\"num\">1 118 000 D</td>");
    expect(html).toContain("1 000 000 C"); // capital : solde créditeur

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
    expect(html).toContain('<td>Prestation de conseil</td><td class="num">2</td><td class="center">jour</td><td class="num">150 000</td><td class="num"></td><td class="num">18 %</td><td class="num">300 000</td><td class="num">54 000</td><td class="num">354 000</td>');
    expect(html).toContain("Net à payer : 379 000 XOF");
    expect(html).toMatch(/<td class="center">0 %<\/td><td class="num">25 000<\/td><td class="num">0<\/td>/); // récapitulatif TVA calculé
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
    expect(html).toContain('SALAIRE BRUT</td><td class="num">530 000</td>');
    expect(html).toContain('<td>CNPS retraite</td><td class="num">530 000</td><td class="num">6,3 %</td><td class="num">33 390</td><td class="num">7,7 %</td><td class="num">40 810</td>');
    expect(html).toContain('Total cotisations</td><td class="num">33 390</td><td></td><td class="num">44 835</td>');
    expect(html).toContain('<td>ITS</td><td class="num">496 610</td><td class="num"></td><td class="num">42 000</td>');
    expect(html).toContain("NET À PAYER : 454 610 XOF");
    expect(html).toContain("Coût total employeur : <b>574 835 XOF</b>");
    expect(html).toContain("Solde de congés (jours) : 12.5");
    expect(renderHtml("payslip", slip, { locale: "en" })).toContain("NET PAY : 454 610 XOF");
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
    expect(html).toContain('Solde du relevé bancaire 30/09/2025</td><td class="num">1 500 000</td>');
    expect(html).toContain("Chèque n° 118 fournisseur");
    expect(html).toContain('<td class="num neg">−80 000</td>');
    expect(html).toContain('<span class="badge ok">Rapprochement équilibré</span>');
    expect(html).toContain("Opérations lettrées : 14");
    const ko = renderHtml("bank-reconciliation", { ...rec, adjustedLedgerBalance: "1400000" });
    expect(ko).toContain("Écart à expliquer");
    expect(ko).toContain('<td class="num">20 000</td>');
  });
});
