// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money } from "./money.js";

/**
 * Reprise des données par la migration 0012 (multidevise).
 *
 * Toute ligne écrite avant cette migration est monodevise. La reprise doit donc
 * être strictement neutre : mêmes soldes, mêmes hashes, mêmes montants. Ce test
 * monte une base au schéma d'avant 0012, y écrit un exercice complet en SQL
 * direct, photographie les soldes, applique 0012, et compare.
 *
 * Il exige DATABASE_URL avec le droit CREATE DATABASE ; sans variable, il est
 * ignoré, comme les autres tests d'intégration.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");
const MULTICURRENCY = "0012_multicurrency.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function apply(db: Sql, files: string[]): Promise<void> {
  // Même journal de migration que `@arcompt/db` : certaines migrations le lisent.
  await db`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of files) {
    await db.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
      await tx`INSERT INTO schema_migration (name) VALUES (${f})`;
    });
  }
}

const base = process.env.DATABASE_URL;
const run = base ? describe : describe.skip;

let admin: Sql;
let db: Sql;
let name: string;
let tenant: string;

run("migration 0012 — reprise des données existantes", () => {
  /** Photographie de tout ce qu'un comptable verrait changer. */
  async function snapshot(sql: Sql) {
    const balances = await sql`
      SELECT a.number, b.debit::text AS debit, b.credit::text AS credit
        FROM account_balance b JOIN account a ON a.id = b.account_id
       WHERE b.tenant_id = ${tenant} ORDER BY a.number, b.period_id`;
    const entries = await sql`
      SELECT number, hash, prev_hash, status FROM journal_entry WHERE tenant_id = ${tenant} ORDER BY number NULLS LAST, id`;
    const lines = await sql`
      SELECT l.line_no, a.number, l.debit::text AS debit, l.credit::text AS credit, l.currency, l.rate::text AS rate
        FROM journal_line l JOIN account a ON a.id = l.account_id
       WHERE l.tenant_id = ${tenant} ORDER BY a.number, l.line_no, l.debit`;
    return {
      balances: balances.map((r) => ({ ...r })),
      entries: entries.map((r) => ({ ...r })),
      lines: lines.map((r) => ({ ...r })),
    };
  }

  let before: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    admin = postgres(base!, { max: 1, onnotice: () => {} });
    name = `arcompt_mc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = base!.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
    db = postgres(url, {
      max: 2,
      onnotice: () => {},
      transform: { undefined: null },
      types: { numeric: { to: 1700, from: [1700], serialize: (v: unknown) => String(v), parse: (v: string) => v } },
    });

    // ----- schéma d'avant la multidevise -----
    const files = migrationFiles();
    const beforeFiles = files.filter((f) => f < MULTICURRENCY);
    expect(beforeFiles).toContain("0001_core.sql");
    await apply(db, beforeFiles);
    // La colonne n'existe pas encore : c'est bien l'état « avant » qu'on peuple.
    const [col] = await db`SELECT 1 AS present FROM information_schema.columns WHERE table_name = 'journal_line' AND column_name = 'debit_base'`;
    expect(col).toBeUndefined();

    // ----- un exercice monodevise, écrit en SQL direct -----
    const [org] = await db`INSERT INTO organization (name) VALUES ('Héritage') RETURNING id`;
    const orgId = org!.id as string;
    const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'h@h.h', 'H') RETURNING id`;
    const userId = u!.id as string;
    const [c] = await db`
      INSERT INTO company (organization_id, name, country_code, currency, pack_version)
      VALUES (${orgId}, 'Dossier hérité', 'CI', 'XOF', 'ci@2025.1') RETURNING id`;
    tenant = c!.id as string;
    const [fy] = await db`INSERT INTO fiscal_year (tenant_id, code, start_date, end_date) VALUES (${tenant}, '2025', '2025-01-01', '2025-12-31') RETURNING id`;
    const [period] = await db`INSERT INTO period (tenant_id, fiscal_year_id, start_date, end_date) VALUES (${tenant}, ${fy!.id}, '2025-03-01', '2025-03-31') RETURNING id`;
    const [journal] = await db`INSERT INTO journal (tenant_id, code, label, type) VALUES (${tenant}, 'VT', 'Ventes', 'VENTES') RETURNING id`;
    const accounts: Record<string, string> = {};
    for (const [number, label, cls, nature, lettrable] of [
      ["411", "Clients", 4, "MIXTE", true],
      ["443", "TVA facturée", 4, "MIXTE", false],
      ["706", "Services vendus", 7, "PRODUIT", false],
    ] as Array<[string, string, number, string, boolean]>) {
      const [a] = await db`
        INSERT INTO account (tenant_id, number, label, class, nature, lettrable)
        VALUES (${tenant}, ${number}, ${label}, ${cls}, ${nature}, ${lettrable}) RETURNING id`;
      accounts[number] = a!.id as string;
    }
    const [p] = await db`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenant}, 'CUSTOMER', 'Client', '411') RETURNING id`;
    const partnerId = p!.id as string;

    const entryId = randomUUID();
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO journal_entry (id, tenant_id, journal_id, fiscal_year_id, period_id, entry_date, label, source, created_by)
        VALUES (${entryId}, ${tenant}, ${journal!.id}, ${fy!.id}, ${period!.id}, '2025-03-15', 'Facture', 'INVOICE', ${userId})`;
      for (const [no, number, debit, credit] of [
        [1, "411", "1180000.0000", "0.0000"],
        [2, "706", "0.0000", "1000000.0000"],
        [3, "443", "0.0000", "180000.0000"],
      ] as Array<[number, string, string, string]>) {
        await tx`
          INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit, currency)
          VALUES (${randomUUID()}, ${tenant}, ${entryId}, ${no}, ${accounts[number]!}, ${number === "411" ? partnerId : null}, '', ${debit}, ${credit}, 'XOF')`;
      }
    });
    // Validation : c'est elle qui alimente account_balance par trigger.
    await db`
      UPDATE journal_entry
         SET status = 'VALIDATED', number = 1, prev_hash = NULL, hash = ${"a".repeat(64)}, validated_by = ${userId}, validated_at = now()
       WHERE id = ${entryId}`;
    // Un brouillon reste en l'état : la reprise ne doit pas le toucher non plus.
    const draftId = randomUUID();
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO journal_entry (id, tenant_id, journal_id, fiscal_year_id, period_id, entry_date, label, source, created_by)
        VALUES (${draftId}, ${tenant}, ${journal!.id}, ${fy!.id}, ${period!.id}, '2025-03-20', 'Brouillon', 'MANUAL', ${userId})`;
      await tx`
        INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit, currency)
        VALUES (${randomUUID()}, ${tenant}, ${draftId}, 1, ${accounts["411"]!}, ${partnerId}, '', 500.0000, 0, 'XOF')`;
      await tx`
        INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit, currency)
        VALUES (${randomUUID()}, ${tenant}, ${draftId}, 2, ${accounts["706"]!}, NULL, '', 0, 500.0000, 'XOF')`;
    });

    before = await snapshot(db);
    await apply(db, [MULTICURRENCY]);
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("ne déplace pas un seul solde, ni un seul hash", async () => {
    const after = await snapshot(db);
    expect(after.balances).toEqual(before.balances);
    expect(after.entries).toEqual(before.entries);
    expect(after.lines).toEqual(before.lines);
    expect(before.balances.length).toBeGreaterThan(0);
  });

  it("reprend chaque ligne existante avec un montant converti égal au montant d'origine", async () => {
    const rows = await db`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE debit_base = debit AND credit_base = credit)::int AS identiques,
             count(*) FILTER (WHERE rate IS NOT NULL)::int AS converties,
             count(*) FILTER (WHERE rate_source IS NOT NULL)::int AS sourcees
        FROM journal_line WHERE tenant_id = ${tenant}`;
    expect(rows[0]).toMatchObject({ total: 5, identiques: 5, converties: 0, sourcees: 0 });
  });

  it("la balance reste équilibrée, débits convertis contre crédits convertis", async () => {
    const [sums] = await db`
      SELECT coalesce(sum(l.debit_base), 0)::text AS d, coalesce(sum(l.credit_base), 0)::text AS c
        FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
       WHERE l.tenant_id = ${tenant} AND e.status = 'VALIDATED'`;
    expect(sums!.d).toBe(sums!.c);
    expect(sums!.d).toBe("1180000.0000");
  });

  it("installe les parités fixes de la zone franc, hors de tout dossier", async () => {
    const rows = await db`SELECT from_currency, to_currency, rate::text AS rate, source FROM exchange_rate WHERE tenant_id IS NULL ORDER BY from_currency, to_currency`;
    expect(rows.find((r) => r.from_currency === "EUR" && r.to_currency === "XOF")).toMatchObject({ rate: "655.9570000000", source: "FIXED" });
    expect(rows.find((r) => r.from_currency === "EUR" && r.to_currency === "XAF")).toMatchObject({ rate: "655.9570000000" });
    expect(rows.every((r) => r.source === "FIXED")).toBe(true);
  });

  it("exige désormais un taux sur toute ligne en devise étrangère, et calcule elle-même la conversion", async () => {
    const [journal] = await db`SELECT id FROM journal WHERE tenant_id = ${tenant} AND code = 'VT'`;
    const [fy] = await db`SELECT id FROM fiscal_year WHERE tenant_id = ${tenant}`;
    const [period] = await db`SELECT id FROM period WHERE tenant_id = ${tenant}`;
    const [acc] = await db`SELECT id FROM account WHERE tenant_id = ${tenant} AND number = '706'`;
    const [client] = await db`SELECT id FROM account WHERE tenant_id = ${tenant} AND number = '411'`;
    const [partner] = await db`SELECT id FROM partner WHERE tenant_id = ${tenant}`;

    const insert = (rate: string | null) =>
      db.begin(async (tx) => {
        const id = randomUUID();
        await tx`
          INSERT INTO journal_entry (id, tenant_id, journal_id, fiscal_year_id, period_id, entry_date, label, source, created_by)
          VALUES (${id}, ${tenant}, ${journal!.id}, ${fy!.id}, ${period!.id}, '2025-03-25', 'Export', 'INVOICE', ${randomUUID()})`;
        await tx`
          INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit, currency, rate)
          VALUES (${randomUUID()}, ${tenant}, ${id}, 1, ${client!.id}, ${partner!.id}, '', 1000, 0, 'EUR', ${rate})`;
        await tx`
          INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit, currency, rate)
          VALUES (${randomUUID()}, ${tenant}, ${id}, 2, ${acc!.id}, NULL, '', 0, 1000, 'EUR', ${rate})`;
        return id;
      });

    await expect(insert(null)).rejects.toThrow(/sans taux de conversion/);

    const id = await insert("655.9570000000");
    const lines = await db`SELECT debit::text AS d, credit::text AS c, debit_base::text AS db, credit_base::text AS cb FROM journal_line WHERE entry_id = ${id} ORDER BY line_no`;
    // Le montant d'origine est conservé, le converti est calculé par la base.
    expect(lines[0]).toMatchObject({ d: "1000.0000", db: "655957.0000" });
    expect(lines[1]).toMatchObject({ c: "1000.0000", cb: "655957.0000" });
  });

  it("arrondit la conversion exactement comme Money.mulRate, y compris sur un demi", async () => {
    // Le trigger recalcule le montant converti : si PostgreSQL et Money
    // arrondissaient différemment, l'objet rendu à l'application et la ligne
    // stockée divergeraient sans que personne ne le voie.
    const cas: Array<[string, string]> = [
      ["1", "0.00005"], // demi exact : arrondi au plus proche, demi vers l'infini
      ["1", "0.00015"],
      ["3", "0.00005"],
      ["1234.5678", "655.957"],
      ["100000", "0.0680000000"],
    ];
    for (const [amount, rate] of cas) {
      const [row] = await db`SELECT round(${amount}::numeric(20, 4) * ${rate}::numeric(20, 10), 4)::text AS converted`;
      expect(`${amount}×${rate}=${row!.converted}`).toBe(`${amount}×${rate}=${Money.parse(amount).mulRate(rate).toString()}`);
    }
  });

  it("refuse une écriture qui n'est équilibrée qu'avant conversion", async () => {
    const [journal] = await db`SELECT id FROM journal WHERE tenant_id = ${tenant} AND code = 'VT'`;
    const [fy] = await db`SELECT id FROM fiscal_year WHERE tenant_id = ${tenant}`;
    const [period] = await db`SELECT id FROM period WHERE tenant_id = ${tenant}`;
    const [acc] = await db`SELECT id FROM account WHERE tenant_id = ${tenant} AND number = '706'`;
    const [client] = await db`SELECT id FROM account WHERE tenant_id = ${tenant} AND number = '411'`;
    const [partner] = await db`SELECT id FROM partner WHERE tenant_id = ${tenant}`;
    await expect(
      db.begin(async (tx) => {
        const id = randomUUID();
        await tx`
          INSERT INTO journal_entry (id, tenant_id, journal_id, fiscal_year_id, period_id, entry_date, label, source, created_by)
          VALUES (${id}, ${tenant}, ${journal!.id}, ${fy!.id}, ${period!.id}, '2025-03-26', 'Euro contre franc', 'MANUAL', ${randomUUID()})`;
        // 1 000 EUR au débit contre 1 000 XOF au crédit : les nombres coïncident,
        // les valeurs non.
        await tx`
          INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit, currency, rate)
          VALUES (${randomUUID()}, ${tenant}, ${id}, 1, ${client!.id}, ${partner!.id}, '', 1000, 0, 'EUR', 655.9570000000)`;
        await tx`
          INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit, currency, rate)
          VALUES (${randomUUID()}, ${tenant}, ${id}, 2, ${acc!.id}, NULL, '', 0, 1000, 'XOF', NULL)`;
      }),
    ).rejects.toThrow(/déséquilibrée/);
  });

  it("interdit à un dossier de toucher aux parités fixes du système", async () => {
    // Le rôle applicatif est soumis à la RLS ; la politique d'écriture ne couvre
    // que ses propres taux.
    await db.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_app_login') THEN CREATE ROLE arcompt_app_login LOGIN PASSWORD 'arcompt_app' IN ROLE arcompt_app; END IF; END $$`,
    );
    const appUrl = new URL(base!.replace(/\/[^/?]+(\?|$)/, `/${name}$1`));
    appUrl.username = "arcompt_app_login";
    appUrl.password = "arcompt_app";
    const appDb = postgres(appUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      const deleted = await appDb.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenant}, true)`;
        return tx`DELETE FROM exchange_rate WHERE tenant_id IS NULL RETURNING id`;
      });
      expect(deleted).toHaveLength(0);
      // Mais il les lit.
      const visible = await appDb.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenant}, true)`;
        return tx`SELECT count(*)::int AS n FROM exchange_rate WHERE tenant_id IS NULL`;
      });
      expect((visible as unknown as Array<{ n: number }>)[0]!.n).toBe(8);
    } finally {
      await appDb.end();
    }
  });
});
