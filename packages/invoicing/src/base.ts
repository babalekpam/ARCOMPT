import type { Sql } from "postgres";
import { Money, type Ledger } from "@arcompt/ledger";
import { withTenant } from "@arcompt/db";
import type { CountryPack } from "@arcompt/country-packs";
import { DEFAULT_TEMPLATES, type PostingContext, type PostingEventKind, type PostingTemplate } from "@arcompt/posting";
import type { CertificationConnector } from "./certification.js";
import type { DunningSender } from "./dunning.js";
import type { PaymentProvider } from "./payment-provider.js";
import type { PaymentKind, PurchaseKind, SalesKind, TenantContext } from "./types.js";

export type InvoicingErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "INVALID_STATUS"
  | "CERTIFICATION_REQUIRED"
  | "CERTIFICATION_FAILED"
  | "OVER_ALLOCATION"
  | "PARTNER_MISMATCH"
  | "PROVIDER_UNKNOWN"
  | "PERIOD_CLOSED"
  | "APPROVAL_REQUIRED"
  | "SAME_USER"
  | "INVALID_SIGNATURE"
  | "REPLAY"
  | "DUPLICATE"
  | "DUNNING_NOT_SENT";

/** Erreur métier du module : le code se traduit en statut HTTP côté API. */
export class InvoicingError extends Error {
  override name = "InvoicingError";
  constructor(
    readonly code: InvoicingErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  get httpStatus(): number {
    switch (this.code) {
      case "NOT_FOUND":
        return 404;
      case "INVALID_STATUS":
      case "DUPLICATE":
      case "PERIOD_CLOSED":
      case "REPLAY":
        return 409;
      case "INVALID_SIGNATURE":
        return 401;
      case "SAME_USER":
        return 403;
      // Le canal de relance n'a pas accepté le message : la panne est en aval.
      case "DUNNING_NOT_SENT":
        return 502;
      case "VALIDATION":
      case "PROVIDER_UNKNOWN":
        return 400;
      default:
        return 422;
    }
  }
}

/** Dépendances communes aux services ; construites une fois par dossier. */
export interface InvoicingDeps {
  db: Sql;
  /** Moteur comptable déjà lié au dossier (PostgresStore sur la même connexion). */
  ledger: Ledger;
  pack: CountryPack;
  /** Devise du dossier. */
  currency: string;
  certification?: CertificationConnector;
  /** Opérateurs de paiement (mobile money) indexés par nom. */
  paymentProviders?: Record<string, PaymentProvider>;
  /**
   * Expéditeur des relances. Sans lui, `recordDunning` refuse : une ligne de
   * relance ne doit jamais dire « envoyée » quand rien n'est parti.
   */
  dunningSender?: DunningSender;
  /** Modèles d'imputation surchargés par le dossier. */
  templates?: Partial<Record<PostingEventKind, PostingTemplate>>;
  /** Comptes par rôle propres au dossier (voir PostingContext). */
  accounts?: PostingContext["accounts"];
  now?: () => Date;
}

export type SequenceKind = SalesKind | PurchaseKind | "PAYMENT";

const PREFIXES: Record<SequenceKind, string> = {
  QUOTE: "DEV",
  INVOICE: "FAC",
  CREDIT_NOTE: "AV",
  SUPPLIER_INVOICE: "FF",
  SUPPLIER_CREDIT_NOTE: "AF",
  EXPENSE_CLAIM: "NDF",
  PAYMENT: "REG",
};

export const EVENT_KIND_BY_PURCHASE: Record<PurchaseKind, PostingEventKind> = {
  SUPPLIER_INVOICE: "PURCHASE_INVOICE",
  SUPPLIER_CREDIT_NOTE: "PURCHASE_CREDIT_NOTE",
  EXPENSE_CLAIM: "EXPENSE_CLAIM",
};

export const EVENT_KIND_BY_PAYMENT: Record<PaymentKind, PostingEventKind> = {
  RECEIPT: "CUSTOMER_PAYMENT",
  DISBURSEMENT: "SUPPLIER_PAYMENT",
};

/** Socle des services : transaction tenant, numérotation, audit, aides SQL. */
export abstract class BaseService {
  constructor(
    protected readonly deps: InvoicingDeps,
    protected readonly ctx: TenantContext,
  ) {}

  protected get tenantId(): string {
    return this.ctx.tenantId;
  }

  protected get actor() {
    return { userId: this.ctx.userId, tenantId: this.ctx.tenantId };
  }

  protected now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  protected tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.deps.db, this.ctx, fn);
  }

  protected template(kind: PostingEventKind): PostingTemplate {
    return this.deps.templates?.[kind] ?? DEFAULT_TEMPLATES[kind];
  }

  protected postingContext(): PostingContext {
    return { pack: this.deps.pack, currency: this.deps.currency, ...(this.deps.accounts ? { accounts: this.deps.accounts } : {}) };
  }

  /**
   * Attribue le prochain numéro légal (continu, sans trou) pour un type et une
   * année. L'incrément est transactionnel : si la transaction appelante échoue,
   * le numéro n'est pas consommé ; s'il est consommé, il ne l'est qu'une fois.
   */
  protected async nextNumber(tx: Sql, kind: SequenceKind, date: string): Promise<string> {
    const year = Number(date.slice(0, 4));
    const prefix = PREFIXES[kind];
    const [row] = await tx`
      INSERT INTO document_sequence (tenant_id, kind, year, prefix, next_number)
      VALUES (${this.tenantId}, ${kind}, ${year}, ${prefix}, 2)
      ON CONFLICT (tenant_id, kind, year) DO UPDATE SET next_number = document_sequence.next_number + 1
      RETURNING next_number - 1 AS n, prefix`;
    return `${row!.prefix}-${year}-${String(row!.n).padStart(4, "0")}`;
  }

  protected async audit(tx: Sql, action: string, entity: string, entityId: string, after?: unknown, before?: unknown): Promise<void> {
    await tx`
      INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
      VALUES (${this.tenantId}, ${this.ctx.userId}, ${action}, ${entity}, ${entityId},
              ${before === undefined ? null : tx.json(before as never)}, ${after === undefined ? null : tx.json(after as never)}, ${this.now().toISOString()})`;
  }

  /** Refuse toute émission dans une période clôturée, verrouillée ou inexistante (antidatage). */
  protected async assertOpenPeriod(tx: Sql, date: string): Promise<void> {
    const [p] = await tx`SELECT status, start_date::text AS start_date, end_date::text AS end_date FROM period WHERE tenant_id = ${this.tenantId} AND ${date}::date BETWEEN start_date AND end_date`;
    if (!p) throw new InvoicingError("PERIOD_CLOSED", `Aucune période ouverte pour la date ${date}`);
    if (p.status !== "OPEN") throw new InvoicingError("PERIOD_CLOSED", `Période ${p.start_date} → ${p.end_date} ${p.status === "LOCKED" ? "verrouillée" : "clôturée"} : émission refusée`);
  }

  /** Seuil de double validation des règlements du dossier (défaut 1 000 000 en devise du dossier). */
  protected async approvalThreshold(tx: Sql): Promise<Money> {
    const [row] = await tx`SELECT payment_approval_threshold::text AS t FROM invoicing_settings WHERE tenant_id = ${this.tenantId}`;
    return row ? Money.parse(row.t as string) : Money.parse("1000000");
  }

  protected async loadPartner(tx: Sql, partnerId: string): Promise<{ id: string; name: string; type: string; collectiveAccount: string; contact: Record<string, unknown> }> {
    const [p] = await tx`SELECT id, name, type, collective_account, contact FROM partner WHERE tenant_id = ${this.tenantId} AND id = ${partnerId}`;
    if (!p) throw new InvoicingError("NOT_FOUND", `Tiers ${partnerId} introuvable`);
    return { id: p.id as string, name: p.name as string, type: p.type as string, collectiveAccount: p.collective_account as string, contact: (p.contact as Record<string, unknown>) ?? {} };
  }
}

export const money = (v: unknown): Money => Money.parse(String(v ?? "0"));
export const dateText = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
export const isoText = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(value: string, field: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new InvoicingError("VALIDATION", `${field} : date invalide (${value})`);
}

/** Nombre de jours entre deux dates ISO (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
