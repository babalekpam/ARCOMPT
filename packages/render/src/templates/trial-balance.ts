import { Money } from "@arcompt/ledger";
import { esc, fmtDate, layout, makeCtx, money, pageFooter, pageHeader, td, type Ctx } from "../html.js";
import type { RenderOptions, TrialBalanceView } from "../views.js";

/**
 * Balance générale : mouvements débit/crédit et soldes par compte, avec un
 * sous-total par classe et un total général.
 */
export function renderTrialBalance(view: TrialBalanceView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, view.currency);
  const meta = [
    `${esc(ctx.L("fiscalYear"))} <b>${esc(view.fiscalYearCode)}</b>`,
    `${esc(ctx.L("period"))} ${esc(ctx.L("from"))} ${esc(fmtDate(view.from, ctx.locale))} ${esc(ctx.L("to"))} ${esc(fmtDate(view.to, ctx.locale))}`,
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
  const c = ctx.currency;
  const rows = [...view.rows].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  const out: string[] = [];
  let cls = "";
  let sub = { debit: Money.zero(), credit: Money.zero(), sd: Money.zero(), sc: Money.zero() };
  let totalSd = Money.zero();
  let totalSc = Money.zero();
  const flush = () => {
    if (!cls) return;
    out.push(`<tr class="subtotal"><td></td><td>${esc(ctx.L("classTotal"))} ${esc(cls)}</td>${td(sub.debit, c)}${td(sub.credit, c)}${td(sub.sd, c)}${td(sub.sc, c)}</tr>`);
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
    out.push(`<tr><td class="code">${esc(r.accountNumber)}</td><td>${esc(r.label)}</td>${td(debit, c)}${td(credit, c)}${td(sd, c)}${td(sc, c)}</tr>`);
  }
  flush();
  out.push(`<tr class="total grand"><td></td><td>${esc(ctx.L("generalTotal"))}</td>${td(view.totalDebit, c)}${td(view.totalCredit, c)}${td(totalSd, c)}${td(totalSc, c)}</tr>`);
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("account"))}</th><th>${esc(ctx.L("accountLabel"))}</th><th>${esc(ctx.L("debit"))}</th><th>${esc(ctx.L("credit"))}</th><th>${esc(ctx.L("debitBalance"))}</th><th>${esc(ctx.L("creditBalance"))}</th></tr></thead>
<tbody>${out.join("\n")}</tbody>
</table>`;
}
