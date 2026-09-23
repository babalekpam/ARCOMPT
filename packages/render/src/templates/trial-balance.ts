import { Money } from "@arcompt/ledger";
import { esc, layout, makeCtx, money, pageFooter, pageHeader, td, type Ctx } from "../html.js";
import type { RenderOptions, TrialBalanceView } from "../views.js";

/**
 * Balance générale : mouvements débit/crédit et soldes par compte, avec un
 * sous-total par classe et un total général.
 */
export function renderTrialBalance(view: TrialBalanceView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, view.currency);
  const meta = [
    `${esc(ctx.L("fiscalYear"))} <b>${esc(view.fiscalYearCode)}</b>`,
    `${esc(ctx.L("period"))} ${esc(ctx.L("from"))} ${esc(ctx.d(view.from))} ${esc(ctx.L("to"))} ${esc(ctx.d(view.to))}`,
    `${esc(ctx.L("amountsIn"))} <b>${esc(view.currency)}</b>`,
  ];
  const body = `<section class="page">
${pageHeader(ctx, ctx.L("trialBalance"), meta)}
<h1>${esc(ctx.L("trialBalance"))} ${esc(view.fiscalYearCode)}</h1>
${table(ctx, view)}
${pageFooter(ctx)}
</section>`;
  return layout(ctx, `${ctx.L("trialBalance")} ${view.fiscalYearCode}`, body);
}

function table(ctx: Ctx, view: TrialBalanceView): string {
  const rows = [...view.rows].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  const out: string[] = [];
  let cls = "";
  let sub = { debit: Money.zero(), credit: Money.zero(), sd: Money.zero(), sc: Money.zero() };
  let totalSd = Money.zero();
  let totalSc = Money.zero();
  const flush = () => {
    if (!cls) return;
    out.push(`<tr class="subtotal"><td></td><td>${esc(ctx.L("classTotal"))} ${esc(cls)}</td>${td(ctx, sub.debit)}${td(ctx, sub.credit)}${td(ctx, sub.sd)}${td(ctx, sub.sc)}</tr>`);
    sub = { debit: Money.zero(), credit: Money.zero(), sd: Money.zero(), sc: Money.zero() };
  };
  for (const r of rows) {
    const rc = r.accountNumber[0] ?? "";
    if (rc !== cls) {
      flush();
      cls = rc;
    }
    const debit = money(r.debit);
    const credit = money(r.credit);
    const balance = debit.sub(credit);
    const sd = balance.isPositive() ? balance : Money.zero();
    const sc = balance.isNegative() ? balance.neg() : Money.zero();
    sub = { debit: sub.debit.add(debit), credit: sub.credit.add(credit), sd: sub.sd.add(sd), sc: sub.sc.add(sc) };
    totalSd = totalSd.add(sd);
    totalSc = totalSc.add(sc);
    out.push(`<tr><td class="code">${esc(r.accountNumber)}</td><td>${esc(r.label)}</td>${td(ctx, debit)}${td(ctx, credit)}${td(ctx, sd)}${td(ctx, sc)}</tr>`);
  }
  flush();
  out.push(`<tr class="total grand"><td></td><td>${esc(ctx.L("generalTotal"))}</td>${td(ctx, view.totalDebit)}${td(ctx, view.totalCredit)}${td(ctx, totalSd)}${td(ctx, totalSc)}</tr>`);
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("account"))}</th><th>${esc(ctx.L("accountLabel"))}</th><th>${esc(ctx.L("debit"))}</th><th>${esc(ctx.L("credit"))}</th><th>${esc(ctx.L("debitBalance"))}</th><th>${esc(ctx.L("creditBalance"))}</th></tr></thead>
<tbody>${out.join("\n")}</tbody>
</table>`;
}
