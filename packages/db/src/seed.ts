import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { Ledger, PostgresStore, DEFAULT_JOURNALS } from "@arcompt/ledger";
import { resolveChart } from "./chart.js";
import { createDb, withTenant, type Db } from "./client.js";

export interface SeedCompanyInput {
  organizationId: string;
  name: string;
  countryCode: string;
  currency: string;
  accountingSystem?: "NORMAL" | "SMT";
  packVersion: string;
  fiscalYear: { code: string; startDate: string; endDate: string };
}

/** Crée un dossier avec son plan de comptes SYSCOHADA, ses journaux et son premier exercice. */
export async function seedCompany(db: Db, input: SeedCompanyInput): Promise<{ companyId: string; fiscalYearId: string }> {
  const [company] = await withTenant(db, { tenantId: "", organizationId: input.organizationId }, (tx) =>
    tx`
      INSERT INTO company (organization_id, name, country_code, currency, accounting_system, pack_version)
      VALUES (${input.organizationId}, ${input.name}, ${input.countryCode}, ${input.currency}, ${input.accountingSystem ?? "NORMAL"}, ${input.packVersion})
      RETURNING id`,
  );
  const companyId = company!.id as string;

  const fiscalYearId = await withTenant(db, { tenantId: companyId, organizationId: input.organizationId }, async (tx) => {
    const chart = resolveChart();
    for (const a of chart) {
      await tx`
        INSERT INTO account (tenant_id, number, label, class, nature, lettrable, postable)
        VALUES (${companyId}, ${a.number}, ${a.label}, ${a.class}, ${a.nature}, ${a.lettrable}, ${a.postable})`;
    }
    for (const j of DEFAULT_JOURNALS) {
      await tx`INSERT INTO journal (tenant_id, code, label, type) VALUES (${companyId}, ${j.code}, ${j.label}, ${j.type})`;
    }
    return "" as string;
  });
  void fiscalYearId;

  const store = new PostgresStore(db as unknown as Sql, { organizationId: input.organizationId });
  const fy = await store.createFiscalYear(companyId, input.fiscalYear);
  return { companyId, fiscalYearId: fy.id };
}

export async function seedDemo(db: Db, log: (m: string) => void = () => {}): Promise<void> {
  const [org] = await db`INSERT INTO organization (name, kind, plan) VALUES ('Cabinet Démo', 'FIRM', 'TRIAL') RETURNING id`;
  const organizationId = org!.id as string;
  const [user] = await db`
    INSERT INTO app_user (organization_id, email, display_name) VALUES (${organizationId}, 'demo@arcompt.local', 'Comptable Démo') RETURNING id`;
  const userId = user!.id as string;

  const { companyId } = await seedCompany(db, {
    organizationId,
    name: "SARL Démo Abidjan",
    countryCode: "CI",
    currency: "XOF",
    packVersion: "ci@2025.1",
    fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" },
  });
  await withTenant(db, { tenantId: companyId, organizationId }, (tx) =>
    tx`INSERT INTO company_member (company_id, user_id, role) VALUES (${companyId}, ${userId}, 'ACCOUNTANT')`,
  );

  const store = new PostgresStore(db as unknown as Sql, { userId, organizationId });
  const ledger = new Ledger(store, { baseCurrency: "XOF" });
  const actor = { userId, tenantId: companyId };

  const [client] = await withTenant(db, { tenantId: companyId }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${companyId}, 'CUSTOMER', 'Client Alpha', '411') RETURNING id`,
  );
  const [supplier] = await withTenant(db, { tenantId: companyId }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${companyId}, 'SUPPLIER', 'Fournisseur Bêta', '401') RETURNING id`,
  );

  await ledger.post(actor, {
    journalCode: "AN",
    date: "2025-01-01",
    label: "Reprise des à-nouveaux",
    source: "IMPORT",
    lines: [
      { accountNumber: "521", debit: "5000000", label: "Banque" },
      { accountNumber: "571", debit: "500000", label: "Caisse" },
      { accountNumber: "244", debit: "3000000", label: "Matériel et mobilier" },
      { accountNumber: "284", credit: "1000000", label: "Amortissements" },
      { accountNumber: "101", credit: "5000000", label: "Capital social" },
      { accountNumber: "121", credit: "2500000", label: "Report à nouveau" },
    ],
  });
  await ledger.post(actor, {
    journalCode: "VT",
    date: "2025-03-15",
    reference: "FAC-2025-001",
    label: "Facture Client Alpha",
    source: "INVOICE",
    lines: [
      { accountNumber: "411", debit: "1180000", partnerId: client!.id as string, label: "Client Alpha" },
      { accountNumber: "706", credit: "1000000", label: "Prestation de services" },
      { accountNumber: "443", credit: "180000", label: "TVA facturée 18 %", vatCode: "TVA18" },
    ],
  });
  await ledger.post(actor, {
    journalCode: "AC",
    date: "2025-03-20",
    reference: "FF-0042",
    label: "Facture Fournisseur Bêta – loyer",
    source: "PURCHASE",
    lines: [
      { accountNumber: "622", debit: "400000", label: "Loyer mars" },
      { accountNumber: "445", debit: "72000", label: "TVA récupérable", vatCode: "TVA18" },
      { accountNumber: "401", credit: "472000", partnerId: supplier!.id as string, label: "Fournisseur Bêta" },
    ],
  });
  await ledger.post(actor, {
    journalCode: "BQ",
    date: "2025-04-02",
    label: "Règlement Client Alpha",
    source: "BANK",
    lines: [
      { accountNumber: "521", debit: "1180000", label: "Virement reçu" },
      { accountNumber: "411", credit: "1180000", partnerId: client!.id as string, label: "Client Alpha" },
    ],
  });
  log(`dossier de démonstration créé : ${companyId}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const db = createDb();
  seedDemo(db, console.log)
    .then(() => db.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
