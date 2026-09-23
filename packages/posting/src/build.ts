// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money, sum, type JournalEntryInput, type JournalLineInput } from "@arcompt/ledger";
import { vatRate } from "@arcompt/country-packs";
import { computeDocumentTotals } from "./totals.js";
import type { AccountRole, ComputedLine, DocumentTotals, LineRule, PostingContext, PostingEvent, PostingTemplate, Side } from "./types.js";

export type PostingErrorCode = "TEMPLATE_MISMATCH" | "MISSING_ACCOUNT" | "MISSING_AMOUNT" | "MISSING_PARTNER" | "UNBALANCED" | "EMPTY_ENTRY";

export class PostingError extends Error {
  override name = "PostingError";
  constructor(
    readonly code: PostingErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Comptes par défaut de chaque rôle (SYSCOHADA révisé), surchargés par `ctx.accounts`. */
export const DEFAULT_ROLE_ACCOUNTS: Record<AccountRole, string | null> = {
  customer: "411",
  supplier: "401",
  employee: "421",
  revenue: "706",
  expense: "638",
  vat_collected: null, // pack
  vat_deductible: null, // pack
  vat_due: "444",
  treasury: null, // événement
  salary_expense: "661",
  social_expense: "664",
  salary_payable: "422",
  social_body: "431",
  withholding_tax: "447",
  depreciation_expense: "681",
  depreciation: null, // ligne (28xx)
  stock: null, // ligne (31x–38x)
  stock_variation: null, // ligne, contrepartie (603x / 73x)
};

const LINE_ROLES: ReadonlySet<AccountRole> = new Set(["revenue", "expense", "depreciation", "stock"]);
/** Rôles dont le compte est la contrepartie de la ligne (`counterAccountNumber`). */
const COUNTER_LINE_ROLES: ReadonlySet<AccountRole> = new Set(["stock_variation"]);
const PARTNER_ROLES: ReadonlySet<AccountRole> = new Set(["customer", "supplier", "employee"]);

/**
 * Résout le numéro de compte d'un rôle pour un événement et, le cas échéant,
 * une ligne de document. Ordre : compte de la ligne (produit / charge /
 * amortissement / stock) → contrepartie de la ligne (variation de stock) →
 * compte collectif du tiers → compte TVA du pack → compte de trésorerie de
 * l'événement → surcharge du dossier → défaut SYSCOHADA.
 */
export function resolveAccount(role: AccountRole, ctx: PostingContext, event: PostingEvent, line?: ComputedLine): string {
  if (LINE_ROLES.has(role) && line?.accountNumber) return line.accountNumber;
  if (COUNTER_LINE_ROLES.has(role) && line?.counterAccountNumber) return line.counterAccountNumber;
  if (PARTNER_ROLES.has(role) && event.partnerAccountNumber) return event.partnerAccountNumber;
  if (role === "vat_collected" || role === "vat_deductible") {
    const pickAccount = (r: { collected_account: string; deductible_account: string }) => (role === "vat_collected" ? r.collected_account : r.deductible_account);
    if (line?.vatCode) return pickAccount(vatRate(ctx.pack, line.vatCode, event.date));
    // Sans code TVA (liquidation) : surcharge du dossier, sinon comptes du premier taux du pack valide à la date.
    const override = ctx.accounts?.[role];
    if (override) return override;
    const anyRate = ctx.pack.vat.rates.find((r) => r.valid_from <= event.date && (r.valid_to === undefined || event.date <= r.valid_to));
    if (!anyRate) throw new PostingError("MISSING_ACCOUNT", `Rôle ${role} : aucun taux de TVA dans le pack ${ctx.pack.code} au ${event.date}`);
    return pickAccount(anyRate);
  }
  if (role === "treasury" && event.treasuryAccountNumber) return event.treasuryAccountNumber;
  const override = ctx.accounts?.[role];
  if (override) return override;
  const fallback = DEFAULT_ROLE_ACCOUNTS[role];
  if (!fallback) throw new PostingError("MISSING_ACCOUNT", `Rôle ${role} : aucun compte résolu pour l'événement ${event.kind}`, { role, line: line?.index });
  return fallback;
}

interface Draft {
  accountNumber: string;
  side: Side;
  amount: Money;
  partnerId: string | null;
  label: string;
  vatCode: string | null;
  analyticCode: string | null;
}

/**
 * Transforme un événement métier en écriture prête pour `Ledger.post()`.
 * Fonction pure : aucun accès à la base ; l'écriture retournée est toujours
 * équilibrée (vérifié avant retour) et ne contient aucune ligne à zéro.
 */
export function buildEntry(event: PostingEvent, template: PostingTemplate, ctx: PostingContext): JournalEntryInput {
  if (event.kind !== template.kind) {
    throw new PostingError("TEMPLATE_MISMATCH", `Modèle ${template.kind} appliqué à un événement ${event.kind}`);
  }
  const totals = computeDocumentTotals(event.lines ?? [], {
    pack: ctx.pack,
    date: event.date,
    currency: event.currency,
    vatRounding: ctx.vatRounding ?? template.vatRounding ?? "per_line",
  });

  const drafts: Draft[] = [];
  const balanceRules: LineRule[] = [];
  for (const rule of template.lines) {
    if (rule.amount === "balance") {
      balanceRules.push(rule);
      continue;
    }
    drafts.push(...expandRule(rule, event, ctx, totals));
  }
  if (balanceRules.length > 1) throw new PostingError("TEMPLATE_MISMATCH", "Un seul sélecteur « balance » par modèle");
  const [balanceRule] = balanceRules;
  if (balanceRule) {
    const debit = sum(drafts.filter((d) => d.side === "debit").map((d) => d.amount));
    const credit = sum(drafts.filter((d) => d.side === "credit").map((d) => d.amount));
    const diff = debit.sub(credit); // > 0 : il manque du crédit
    const wanted: Side = diff.isNegative() ? "debit" : "credit";
    drafts.push(...expandRule({ ...balanceRule, side: wanted }, event, ctx, totals, diff.abs()));
  }

  const lines = drafts
    .filter((d) => !d.amount.isZero())
    .map<JournalLineInput>((d) => ({
      accountNumber: d.accountNumber,
      ...(d.side === "debit" ? { debit: d.amount } : { credit: d.amount }),
      ...(d.partnerId ? { partnerId: d.partnerId } : {}),
      label: d.label,
      ...(d.vatCode ? { vatCode: d.vatCode } : {}),
      ...(d.analyticCode ? { analyticCode: d.analyticCode } : {}),
    }));

  if (lines.length < 2) throw new PostingError("EMPTY_ENTRY", `Événement ${event.kind} : écriture vide ou à une seule ligne`);
  const totalDebit = sum(lines.map((l) => (l.debit ? Money.parse(l.debit) : Money.zero())));
  const totalCredit = sum(lines.map((l) => (l.credit ? Money.parse(l.credit) : Money.zero())));
  if (!totalDebit.eq(totalCredit)) {
    throw new PostingError("UNBALANCED", `Événement ${event.kind} : débits ${totalDebit} ≠ crédits ${totalCredit}`, { totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString() });
  }

  const journalCode = typeof template.journalCode === "function" ? template.journalCode(event) : template.journalCode;
  return {
    journalCode,
    date: event.date,
    ...(event.reference ? { reference: event.reference } : {}),
    label: event.label,
    source: template.source,
    lines,
    ...(event.clientId ? { clientId: event.clientId } : {}),
  };
}

/** Développe une règle en lignes candidates ; `forced` remplace le montant (sélecteur balance). */
function expandRule(rule: LineRule, event: PostingEvent, ctx: PostingContext, totals: DocumentTotals, forced?: Money): Draft[] {
  const group = rule.group ?? "none";
  const partnerOf = (line?: ComputedLine): string | null => {
    const mode = rule.partner ?? "none";
    if (mode === "event") return event.partnerId ?? null;
    if (mode === "line") return line?.partnerId ?? event.partnerId ?? null;
    return null;
  };
  const labelOf = (line?: ComputedLine): string =>
    (rule.label ?? "{label}").replace("{label}", event.label).replace("{line}", line?.label ?? "").trim();
  const make = (accountNumber: string, amount: Money, line?: ComputedLine, vatCode: string | null = null): Draft => {
    const a = amount.isNegative() ? amount.neg() : amount;
    const side: Side = amount.isNegative() ? (rule.side === "debit" ? "credit" : "debit") : rule.side;
    return { accountNumber, side, amount: a, partnerId: partnerOf(line), label: labelOf(line), vatCode: rule.withVatCode ? vatCode : null, analyticCode: line?.analyticCode ?? null };
  };

  if (forced !== undefined) {
    return [make(resolveAccount(rule.role, ctx, event), forced)];
  }

  const sel = rule.amount;
  if (typeof sel === "object") {
    const raw = event.amounts?.[sel.field];
    if (raw === undefined) throw new PostingError("MISSING_AMOUNT", `Événement ${event.kind} : montant « ${sel.field} » manquant`);
    return [make(resolveAccount(rule.role, ctx, event), Money.parse(raw))];
  }
  if (sel === "total_net") return [make(resolveAccount(rule.role, ctx, event), totals.totalNet)];
  if (sel === "total_vat") return [make(resolveAccount(rule.role, ctx, event), totals.totalVat)];
  if (sel === "total_gross") return [make(resolveAccount(rule.role, ctx, event), totals.totalGross)];

  // Sélecteurs par ligne.
  const pick = (c: ComputedLine): Money => (sel === "line_net" ? c.net : sel === "line_vat" ? c.vat : c.gross);
  if (group === "line") {
    return totals.lines.map((c) => make(resolveAccount(rule.role, ctx, event, c), pick(c), c, c.vatCode));
  }
  if (group === "vat_code") {
    return totals.byVatCode.map((row) => {
      const first = totals.lines.find((c) => c.vatCode === row.vatCode)!;
      return make(resolveAccount(rule.role, ctx, event, first), sel === "line_net" ? row.base : sel === "line_vat" ? row.vat : row.base.add(row.vat), undefined, row.vatCode);
    });
  }
  if (group === "account") {
    const acc = new Map<string, Money>();
    for (const c of totals.lines) {
      const n = resolveAccount(rule.role, ctx, event, c);
      acc.set(n, (acc.get(n) ?? Money.zero()).add(pick(c)));
    }
    return [...acc.entries()].map(([n, m]) => make(n, m));
  }
  return [make(resolveAccount(rule.role, ctx, event, totals.lines[0]), sum(totals.lines.map(pick)))];
}
