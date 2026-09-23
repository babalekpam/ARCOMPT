import type { Sql } from "postgres";
import { LedgerError } from "./errors.js";
import { Money } from "./money.js";
import type { AuditEvent, LedgerStore } from "./store.js";
import type {
  Account,
  AccountBalance,
  AccountClass,
  Actor,
  FiscalYear,
  ForeignPosition,
  Id,
  Journal,
  JournalEntry,
  JournalLine,
  Period,
} from "./types.js";
import { monthlyRanges } from "./memory-store.js";

/**
 * Adaptateur PostgreSQL du moteur comptable.
 *
 * Chaque opération s'exécute dans une transaction où `app.tenant_id` est fixé,
 * ce qui active la Row-Level Security : même un bug applicatif ne peut pas
 * lire ou écrire un autre dossier. Les invariants (équilibre, immutabilité,
 * période, chaînage) sont vérifiés une seconde fois par les triggers.
 */
export class PostgresStore implements LedgerStore {
  constructor(
    private readonly sql: Sql,
    private readonly ctx: { userId?: Id; organizationId?: Id } = {},
  ) {}

  private tx<T>(tenantId: Id, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`select set_config('app.organization_id', ${this.ctx.organizationId ?? ""}, true)`;
      await tx`select set_config('app.user_id', ${this.ctx.userId ?? ""}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  async getAccountByNumber(tenantId: Id, number: string): Promise<Account | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`SELECT * FROM account WHERE tenant_id = ${tenantId} AND number = ${number}`;
      return rows[0] ? mapAccount(rows[0]) : null;
    });
  }

  async listAccounts(tenantId: Id): Promise<Account[]> {
    return this.tx(tenantId, async (tx) => (await tx`SELECT * FROM account WHERE tenant_id = ${tenantId} ORDER BY number`).map(mapAccount));
  }

  async getJournalByCode(tenantId: Id, code: string): Promise<Journal | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`SELECT * FROM journal WHERE tenant_id = ${tenantId} AND code = ${code}`;
      return rows[0] ? mapJournal(rows[0]) : null;
    });
  }

  async listJournals(tenantId: Id): Promise<Journal[]> {
    return this.tx(tenantId, async (tx) => (await tx`SELECT * FROM journal WHERE tenant_id = ${tenantId} ORDER BY code`).map(mapJournal));
  }

  async findPeriodForDate(tenantId: Id, date: string) {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`
        SELECT p.id, p.tenant_id, p.fiscal_year_id, p.start_date::text AS start_date, p.end_date::text AS end_date, p.status,
               f.code AS fy_code, f.start_date::text AS fy_start, f.end_date::text AS fy_end, f.status AS fy_status
          FROM period p JOIN fiscal_year f ON f.id = p.fiscal_year_id
         WHERE p.tenant_id = ${tenantId} AND ${date}::date BETWEEN p.start_date AND p.end_date`;
      const r = rows[0];
      if (!r) return null;
      return {
        period: { id: r.id, tenantId: r.tenant_id, fiscalYearId: r.fiscal_year_id, startDate: r.start_date, endDate: r.end_date, status: r.status } as Period,
        fiscalYear: { id: r.fiscal_year_id, tenantId: r.tenant_id, code: r.fy_code, startDate: r.fy_start, endDate: r.fy_end, status: r.fy_status } as FiscalYear,
      };
    });
  }

  async listFiscalYears(tenantId: Id): Promise<FiscalYear[]> {
    return this.tx(tenantId, async (tx) =>
      (await tx`SELECT id, tenant_id, code, start_date::text, end_date::text, status FROM fiscal_year WHERE tenant_id = ${tenantId} ORDER BY start_date`).map(mapFiscalYear),
    );
  }

  async getFiscalYearByCode(tenantId: Id, code: string): Promise<FiscalYear | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`SELECT id, tenant_id, code, start_date::text, end_date::text, status FROM fiscal_year WHERE tenant_id = ${tenantId} AND code = ${code}`;
      return rows[0] ? mapFiscalYear(rows[0]) : null;
    });
  }

  async createFiscalYear(tenantId: Id, fy: Omit<FiscalYear, "id" | "tenantId" | "status">): Promise<FiscalYear> {
    return this.tx(tenantId, async (tx) => {
      const [row] = await tx`
        INSERT INTO fiscal_year (tenant_id, code, start_date, end_date)
        VALUES (${tenantId}, ${fy.code}, ${fy.startDate}, ${fy.endDate})
        RETURNING id, tenant_id, code, start_date::text, end_date::text, status`;
      for (const [start, end] of monthlyRanges(fy.startDate, fy.endDate)) {
        await tx`INSERT INTO period (tenant_id, fiscal_year_id, start_date, end_date) VALUES (${tenantId}, ${row!.id}, ${start}, ${end})`;
      }
      return mapFiscalYear(row!);
    });
  }

  async getEntry(tenantId: Id, entryId: Id): Promise<JournalEntry | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`${entrySelect(tx)} WHERE e.tenant_id = ${tenantId} AND e.id = ${entryId}`;
      return rows[0] ? await hydrate(tx, rows[0]) : null;
    });
  }

  async findEntryByClientId(tenantId: Id, clientId: Id): Promise<JournalEntry | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`${entrySelect(tx)} WHERE e.tenant_id = ${tenantId} AND e.client_id = ${clientId}`;
      return rows[0] ? await hydrate(tx, rows[0]) : null;
    });
  }

  async insertDraft(entry: JournalEntry, clientId?: Id): Promise<JournalEntry> {
    return this.tx(entry.tenantId, async (tx) => {
      // insertDraft sert aussi à réécrire un brouillon existant (lien de contrepassation).
      await tx`DELETE FROM journal_entry WHERE tenant_id = ${entry.tenantId} AND id = ${entry.id} AND status = 'DRAFT'`;
      await tx`
        INSERT INTO journal_entry (id, tenant_id, journal_id, fiscal_year_id, period_id, number, entry_date, reference, label, status, source,
                                   reverses_entry_id, client_id, created_by, created_at)
        VALUES (${entry.id}, ${entry.tenantId}, ${entry.journalId}, ${entry.fiscalYearId}, ${entry.periodId}, NULL, ${entry.date},
                ${entry.reference}, ${entry.label}, 'DRAFT', ${entry.source}, ${entry.reversesEntryId}, ${clientId ?? null},
                ${entry.createdBy}, ${entry.createdAt})`;
      for (const l of entry.lines) {
        await tx`
          INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, partner_id, label, debit, credit,
                                    currency, rate, rate_source, debit_base, credit_base, analytic_code, vat_code)
          VALUES (${l.id}, ${entry.tenantId}, ${entry.id}, ${l.lineNo}, ${l.accountId}, ${l.partnerId}, ${l.label},
                  ${l.debit.toString()}, ${l.credit.toString()}, ${l.currency}, ${l.rate}, ${l.rateSource},
                  ${l.debitBase.toString()}, ${l.creditBase.toString()}, ${l.analyticCode}, ${l.vatCode})`;
      }
      const rows = await tx`${entrySelect(tx)} WHERE e.tenant_id = ${entry.tenantId} AND e.id = ${entry.id}`;
      return hydrate(tx, rows[0]!);
    }).catch(translatePgError);
  }

  async deleteDraft(tenantId: Id, entryId: Id): Promise<void> {
    await this.tx(tenantId, async (tx) => {
      const rows = await tx`SELECT status FROM journal_entry WHERE tenant_id = ${tenantId} AND id = ${entryId}`;
      if (!rows[0]) throw new LedgerError("ENTRY_NOT_FOUND", `Écriture ${entryId} introuvable`);
      if (rows[0].status !== "DRAFT") throw new LedgerError("ENTRY_IMMUTABLE", "Une écriture validée ne se supprime pas ; contrepassez-la");
      await tx`DELETE FROM journal_entry WHERE tenant_id = ${tenantId} AND id = ${entryId}`;
    });
  }

  async lastValidated(tenantId: Id, journalId: Id) {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`
        SELECT number, hash FROM journal_entry
         WHERE tenant_id = ${tenantId} AND journal_id = ${journalId} AND status = 'VALIDATED'
         ORDER BY number DESC LIMIT 1`;
      return rows[0] ? { number: Number(rows[0].number), hash: rows[0].hash as string } : null;
    });
  }

  async markValidated(entry: JournalEntry, fields: { number: number; prevHash: string | null; hash: string; validatedBy: Id; validatedAt: string }) {
    return this.tx(entry.tenantId, async (tx) => {
      const updated = await tx`
        UPDATE journal_entry
           SET status = 'VALIDATED', number = ${fields.number}, prev_hash = ${fields.prevHash}, hash = ${fields.hash},
               validated_by = ${fields.validatedBy}, validated_at = ${fields.validatedAt}
         WHERE tenant_id = ${entry.tenantId} AND id = ${entry.id} AND status = 'DRAFT'
         RETURNING id`;
      if (updated.length === 0) throw new LedgerError("ENTRY_IMMUTABLE", "Écriture introuvable ou déjà validée");
      const rows = await tx`${entrySelect(tx)} WHERE e.tenant_id = ${entry.tenantId} AND e.id = ${entry.id}`;
      return hydrate(tx, rows[0]!);
    }).catch(translatePgError);
  }

  async linkReversal(tenantId: Id, originalId: Id, reversalId: Id): Promise<void> {
    await this.tx(tenantId, async (tx) => {
      await tx`UPDATE journal_entry SET reversed_by_entry_id = ${reversalId} WHERE tenant_id = ${tenantId} AND id = ${originalId}`;
    }).catch(translatePgError);
  }

  async accountBalances(tenantId: Id, from: string, to: string): Promise<AccountBalance[]> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`
        SELECT a.number, a.label, a.class, coalesce(sum(l.debit_base), 0)::text AS debit, coalesce(sum(l.credit_base), 0)::text AS credit
          FROM journal_line l
          JOIN journal_entry e ON e.id = l.entry_id
          JOIN account a ON a.id = l.account_id
         WHERE e.tenant_id = ${tenantId} AND e.status = 'VALIDATED' AND e.entry_date BETWEEN ${from} AND ${to}
         GROUP BY a.number, a.label, a.class
         ORDER BY a.number`;
      return rows.map((r) => ({
        accountNumber: r.number as string,
        label: r.label as string,
        class: Number(r.class) as AccountClass,
        debit: Money.parse(r.debit as string),
        credit: Money.parse(r.credit as string),
      }));
    });
  }

  async foreignPositions(tenantId: Id, from: string, to: string, opts: { accountPrefixes?: string[] } = {}): Promise<ForeignPosition[]> {
    return this.tx(tenantId, async (tx) => {
      // `rate IS NOT NULL` isole les seules lignes converties : une ligne déjà
      // dans la devise du dossier ne porte pas de position de change.
      const prefixes = opts.accountPrefixes && opts.accountPrefixes.length > 0 ? opts.accountPrefixes.map((p) => `${p}%`) : null;
      const rows = await tx`
        SELECT a.number, a.label, a.class, l.partner_id, l.currency,
               coalesce(sum(l.debit), 0)::text AS foreign_debit,
               coalesce(sum(l.credit), 0)::text AS foreign_credit,
               coalesce(sum(l.debit_base), 0)::text AS base_debit,
               coalesce(sum(l.credit_base), 0)::text AS base_credit
          FROM journal_line l
          JOIN journal_entry e ON e.id = l.entry_id
          JOIN account a ON a.id = l.account_id
         WHERE e.tenant_id = ${tenantId} AND e.status = 'VALIDATED' AND e.entry_date BETWEEN ${from} AND ${to}
           AND l.rate IS NOT NULL
           AND (${prefixes}::text[] IS NULL OR a.number LIKE ANY (${prefixes}::text[]))
         GROUP BY a.number, a.label, a.class, l.partner_id, l.currency
         ORDER BY a.number, l.currency, l.partner_id`;
      return rows.map((r) => ({
        accountNumber: r.number as string,
        accountLabel: r.label as string,
        class: Number(r.class) as AccountClass,
        partnerId: (r.partner_id as string | null) ?? null,
        currency: r.currency as string,
        foreignDebit: Money.parse(r.foreign_debit as string),
        foreignCredit: Money.parse(r.foreign_credit as string),
        baseDebit: Money.parse(r.base_debit as string),
        baseCredit: Money.parse(r.base_credit as string),
      }));
    });
  }

  async listValidatedEntries(tenantId: Id, journalId: Id): Promise<JournalEntry[]> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx`${entrySelect(tx)} WHERE e.tenant_id = ${tenantId} AND e.journal_id = ${journalId} AND e.status = 'VALIDATED' ORDER BY e.number`;
      const out: JournalEntry[] = [];
      for (const r of rows) out.push(await hydrate(tx, r));
      return out;
    });
  }

  async listEntries(tenantId: Id, opts: { fiscalYearCode: string; accountNumber?: string }): Promise<JournalEntry[]> {
    return this.tx(tenantId, async (tx) => {
      // Filtre par préfixe de compte : une écriture est retenue si l'une de ses lignes touche le compte.
      const prefix = opts.accountNumber ? `${opts.accountNumber}%` : null;
      const rows = await tx`${entrySelect(tx)}
        JOIN fiscal_year f ON f.id = e.fiscal_year_id
       WHERE e.tenant_id = ${tenantId} AND e.status = 'VALIDATED' AND f.code = ${opts.fiscalYearCode}
         AND (${prefix}::text IS NULL OR EXISTS (
               SELECT 1 FROM journal_line l JOIN account a ON a.id = l.account_id
                WHERE l.entry_id = e.id AND a.number LIKE ${prefix}))
       ORDER BY e.entry_date, j.code, e.number`;
      const out: JournalEntry[] = [];
      for (const r of rows) out.push(await hydrate(tx, r));
      return out;
    });
  }

  async setPeriodStatus(tenantId: Id, periodId: Id, status: Period["status"], _actor: Actor): Promise<void> {
    await this.tx(tenantId, async (tx) => {
      await tx`UPDATE period SET status = ${status} WHERE tenant_id = ${tenantId} AND id = ${periodId}`;
    });
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.tx(event.tenantId, async (tx) => {
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
        VALUES (${event.tenantId}, ${event.userId}, ${event.action}, ${event.entity}, ${event.entityId},
                ${event.before === undefined ? null : tx.json(event.before as never)}, ${event.after === undefined ? null : tx.json(event.after as never)}, ${event.at})`;
    });
  }
}

function entrySelect(tx: Sql) {
  return tx`
    SELECT e.id, e.tenant_id, e.journal_id, j.code AS journal_code, e.fiscal_year_id, e.period_id, e.number,
           e.entry_date::text AS entry_date, e.reference, e.label, e.status, e.source, e.reverses_entry_id, e.reversed_by_entry_id,
           e.prev_hash, e.hash, e.created_by, e.created_at, e.validated_by, e.validated_at
      FROM journal_entry e JOIN journal j ON j.id = e.journal_id`;
}

async function hydrate(tx: Sql, r: Record<string, unknown>): Promise<JournalEntry> {
  const lines = await tx`
    SELECT l.id, l.entry_id, l.line_no, l.account_id, a.number AS account_number, l.partner_id, l.label,
           l.debit::text AS debit, l.credit::text AS credit, l.currency, l.rate::text AS rate, l.rate_source,
           l.debit_base::text AS debit_base, l.credit_base::text AS credit_base, l.analytic_code, l.vat_code
      FROM journal_line l JOIN account a ON a.id = l.account_id
     WHERE l.entry_id = ${r.id as string} ORDER BY l.line_no`;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    journalId: r.journal_id as string,
    journalCode: r.journal_code as string,
    fiscalYearId: r.fiscal_year_id as string,
    periodId: r.period_id as string,
    number: r.number === null ? null : Number(r.number),
    date: r.entry_date as string,
    reference: (r.reference as string | null) ?? null,
    label: r.label as string,
    status: r.status as JournalEntry["status"],
    source: r.source as JournalEntry["source"],
    reversesEntryId: (r.reverses_entry_id as string | null) ?? null,
    reversedByEntryId: (r.reversed_by_entry_id as string | null) ?? null,
    prevHash: (r.prev_hash as string | null) ?? null,
    hash: (r.hash as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: toIso(r.created_at),
    validatedBy: (r.validated_by as string | null) ?? null,
    validatedAt: r.validated_at ? toIso(r.validated_at) : null,
    lines: lines.map<JournalLine>((l) => ({
      id: l.id as string,
      entryId: l.entry_id as string,
      lineNo: Number(l.line_no),
      accountId: l.account_id as string,
      accountNumber: l.account_number as string,
      partnerId: (l.partner_id as string | null) ?? null,
      label: l.label as string,
      debit: Money.parse(l.debit as string),
      credit: Money.parse(l.credit as string),
      currency: l.currency as string,
      rate: (l.rate as string | null) ?? null,
      rateSource: (l.rate_source as string | null) ?? null,
      debitBase: Money.parse(l.debit_base as string),
      creditBase: Money.parse(l.credit_base as string),
      analyticCode: (l.analytic_code as string | null) ?? null,
      vatCode: (l.vat_code as string | null) ?? null,
    })),
  };
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapAccount(r: Record<string, unknown>): Account {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    number: r.number as string,
    label: r.label as string,
    class: Number(r.class) as AccountClass,
    nature: r.nature as Account["nature"],
    lettrable: Boolean(r.lettrable),
    postable: Boolean(r.postable),
    active: Boolean(r.active),
  };
}

function mapJournal(r: Record<string, unknown>): Journal {
  return { id: r.id as string, tenantId: r.tenant_id as string, code: r.code as string, label: r.label as string, type: r.type as Journal["type"] };
}

function mapFiscalYear(r: Record<string, unknown>): FiscalYear {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    code: r.code as string,
    startDate: r.start_date as string,
    endDate: r.end_date as string,
    status: r.status as FiscalYear["status"],
  };
}

/** Convertit les erreurs des triggers (codes P000x) en LedgerError. */
function translatePgError(e: unknown): never {
  const code = (e as { code?: string }).code;
  const message = (e as Error).message ?? String(e);
  switch (code) {
    case "P0002":
      throw new LedgerError("UNBALANCED", message);
    case "P0003":
      throw new LedgerError("ENTRY_IMMUTABLE", message);
    case "P0004":
      throw new LedgerError("PERIOD_LOCKED", message);
    case "P0005":
      throw new LedgerError("HASH_CHAIN_BROKEN", message);
    case "P0006":
      throw new LedgerError("UNKNOWN_ACCOUNT", message);
    case "P0007":
      throw new LedgerError("RATE_INVALID", message);
    default:
      throw e;
  }
}
