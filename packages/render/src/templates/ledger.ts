import { Money } from "@arcompt/ledger";
import { esc, layout, makeCtx, money, pageFooter, pageHeader, td, type Ctx } from "../html.js";
import type { LedgerAccountView, LedgerView, RenderOptions } from "../views.js";

/**
 * Grand livre : pour chaque compte, les écritures validées de la période
 * avec solde progressif, total du compte et solde de clôture (sens D/C).
 */
export function renderLedger(view: LedgerView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, view.currency);
  const meta = [
    `${esc(ctx.L("fiscalYear"))} <b>${esc(view.fiscalYearCode)}</b>`,
    `${esc(ctx.L("period"))} ${esc(ctx.L("from"))} ${esc(ctx.d(view.from))} ${esc(ctx.L("to"))} ${esc(ctx.d(view.to))}`,
    `${esc(ctx.L("amountsIn"))} <b>${esc(view.currency)}</b>`,
  ];
  const accounts = view.accounts.length ? view.accounts.map((a) => accountSection(ctx, a, view)).join("\n") : `<p class="muted">${esc(ctx.L("noEntries"))}</p>`;
  const body = `<section class="page landscape">
${pageHeader(ctx, ctx.L("ledger"), meta)}
<h1>${esc(ctx.L("ledger"))} ${esc(view.fiscalYearCode)}</h1>
${accounts}
${pageFooter(ctx)}
</section>`;
  return layout(ctx, `${ctx.L("ledger")} ${view.fiscalYearCode}`, body);
}

function accountSection(ctx: Ctx, a: LedgerAccountView, view: LedgerView): string {
  let running = Money.zero();
  const rows = a.lines
    .map((l) => {
      running = running.add(money(l.debit)).sub(money(l.credit));
      return `<tr><td>${esc(ctx.d(l.date))}</td><td class="code">${esc(l.journalCode)}</td><td class="code">${l.entryNumber ?? ""}</td><td>${esc(l.reference ?? "")}</td><td>${esc(l.label)}</td>${td(ctx, l.debit)}${td(ctx, l.credit)}<td class="num">${esc(ctx.dc(running))}</td></tr>`;
    })
    .join("\n");
  return `<section class="account">
<h2>${esc(a.accountNumber)} – ${esc(a.label)}</h2>
<table class="fin">
<thead><tr><th>${esc(ctx.L("date"))}</th><th>${esc(ctx.L("journal"))}</th><th>${esc(ctx.L("entryNumber"))}</th><th>${esc(ctx.L("reference"))}</th><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("debit"))}</th><th>${esc(ctx.L("credit"))}</th><th>${esc(ctx.L("balance"))}</th></tr></thead>
<tbody>${rows || `<tr><td colspan="8" class="muted">${esc(ctx.L("noEntries"))}</td></tr>`}
<tr class="total"><td colspan="5">${esc(ctx.L("accountTotal"))}</td>${td(ctx, a.totalDebit)}${td(ctx, a.totalCredit)}<td class="num">${esc(ctx.dc(a.balance))}</td></tr>
</tbody>
</table>
<p class="small right">${ctx.kv(`${esc(ctx.L("closingBalance"))} ${esc(ctx.d(view.to))}`, `<b>${esc(ctx.dc(a.balance))}</b>`)}</p>
</section>`;
}
