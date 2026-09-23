import { Money } from "@arcompt/ledger";
import { esc, layout, makeCtx, money, pageFooter, pageHeader, td, type Ctx } from "../html.js";
import type { BankReconciliationView, ReconciliationItemView, RenderOptions } from "../views.js";

/**
 * État de rapprochement bancaire : soldes de départ, opérations en suspens
 * de chaque côté, soldes ajustés et écart résiduel.
 */
export function renderBankReconciliation(v: BankReconciliationView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, v.currency);
  const diff = money(v.adjustedStatementBalance).sub(money(v.adjustedLedgerBalance));
  const meta = [
    ctx.kv(esc(ctx.L("bankAccount")), `<b>${esc(v.bankAccount.label)}</b> (${esc(v.bankAccount.ledgerAccount)})`),
    v.bankAccount.bankName ? esc(v.bankAccount.bankName) + (v.bankAccount.iban ? ` – ${esc(v.bankAccount.iban)}` : "") : "",
    `${esc(ctx.L("period"))} ${esc(ctx.L("from"))} ${esc(ctx.d(v.period.start))} ${esc(ctx.L("to"))} ${esc(ctx.d(v.period.end))}`,
    `${esc(ctx.L("amountsIn"))} <b>${esc(v.currency)}</b>`,
  ].filter(Boolean);
  const body = `<section class="page">
${pageHeader(ctx, ctx.L("bankReconciliation"), meta)}
<h1>${esc(ctx.L("bankReconciliation"))}</h1>
<table class="fin">
<tbody>
<tr class="subtotal"><td>${esc(ctx.L("statementBalance"))} ${esc(ctx.d(v.period.end))}</td>${td(ctx, v.statementBalance, { zero: "zero" })}</tr>
<tr class="subtotal"><td>${esc(ctx.L("ledgerBalance"))} ${esc(ctx.d(v.period.end))}</td>${td(ctx, v.ledgerBalance, { zero: "zero" })}</tr>
<tr class="total"><td>${esc(ctx.L("adjustedStatementBalance"))}</td>${td(ctx, v.adjustedStatementBalance, { zero: "zero" })}</tr>
<tr class="total"><td>${esc(ctx.L("adjustedLedgerBalance"))}</td>${td(ctx, v.adjustedLedgerBalance, { zero: "zero" })}</tr>
<tr class="grand"><td>${ctx.kv(esc(ctx.L("difference")), diff.isZero() ? `<span class="badge ok">${esc(ctx.L("reconciled"))}</span>` : `<span class="badge ko">${esc(ctx.L("notReconciled"))}</span>`)}</td>${td(ctx, diff, { zero: "zero" })}</tr>
</tbody>
</table>
${v.matchedCount !== undefined ? `<p class="small">${ctx.kv(esc(ctx.L("matchedItems")), String(v.matchedCount))}</p>` : ""}
${itemsTable(ctx, ctx.L("ledgerOnly"), v.ledgerOnly)}
${itemsTable(ctx, ctx.L("bankOnly"), v.bankOnly)}
${pageFooter(ctx)}
</section>`;
  return layout(ctx, `${ctx.L("bankReconciliation")} – ${v.bankAccount.label}`, body);
}

function itemsTable(ctx: Ctx, title: string, items: ReconciliationItemView[]): string {
  const total = items.reduce((acc, i) => acc.add(money(i.amount)), Money.zero());
  const rows = items.length
    ? items.map((i) => `<tr><td>${esc(ctx.d(i.date))}</td><td>${esc(i.reference ?? "")}</td><td>${esc(i.label)}</td>${td(ctx, i.amount, { zero: "zero" })}</tr>`).join("\n")
    : `<tr><td colspan="4" class="muted">${esc(ctx.L("none"))}</td></tr>`;
  return `<h2>${esc(title)}</h2>
<table class="fin">
<thead><tr><th>${esc(ctx.L("date"))}</th><th>${esc(ctx.L("reference"))}</th><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("amount"))}</th></tr></thead>
<tbody>${rows}
<tr class="total"><td colspan="3">${esc(ctx.L("total"))}</td>${td(ctx, total, { zero: "zero" })}</tr></tbody>
</table>`;
}
