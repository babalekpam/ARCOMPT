import { companyBlock, esc, fmt, fmtDate, layout, makeCtx, pageFooter, td } from "../html.js";
import type { PayslipItemView, PayslipView, RenderOptions } from "../views.js";

/**
 * Bulletin de paie : identification employeur/salarié, éléments de
 * rémunération jusqu'au brut, cotisations (parts salariale et patronale),
 * impôt sur salaires, net à payer et coût employeur.
 */
export function renderPayslip(p: PayslipView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, p.currency);
  const c = p.currency;
  const periodLabel = p.period.label ?? `${fmtDate(p.period.start, ctx.locale)} – ${fmtDate(p.period.end, ctx.locale)}`;

  const contributions = p.contributions
    .map(
      (r) => `<tr><td>${esc(r.label)}</td>${td(r.base, c, { zero: "zero" })}<td class="num">${esc(r.employeeRate ?? "")}</td>${td(r.employeeAmount, c, { zero: "zero" })}<td class="num">${esc(r.employerRate ?? "")}</td>${td(r.employerAmount, c, { zero: "zero" })}</tr>`,
    )
    .join("\n");

  const body = `<section class="page">
<header class="doc-header">
  ${companyBlock(opts.company, ctx)}
  <div class="meta">
    <div class="doc-title">${esc(ctx.L("payslip"))}</div>
    <div>${esc(ctx.L("period"))} : <b>${esc(periodLabel)}</b></div>
    ${p.paymentDate ? `<div>${esc(ctx.L("paymentDate"))} : ${esc(fmtDate(p.paymentDate, ctx.locale))}</div>` : ""}
    ${p.paymentMode ? `<div>${esc(ctx.L("paymentMode"))} : ${esc(p.paymentMode)}</div>` : ""}
    <div>${esc(ctx.L("currency"))} : ${esc(c)}</div>
  </div>
</header>
<div class="row">
  <div class="col box">
    <div class="small muted">${esc(ctx.L("employee"))}</div>
    <div class="company-name">${esc(p.employee.fullName)}</div>
    <table class="kv">
      ${kv(ctx.L("employeeNumber"), p.employee.employeeNumber)}
      ${kv(ctx.L("jobTitle"), p.employee.jobTitle)}
      ${kv(ctx.L("category"), p.employee.category)}
      ${kv(ctx.L("hireDate"), p.employee.hireDate ? fmtDate(p.employee.hireDate, ctx.locale) : undefined)}
      ${kv(ctx.L("socialSecurityNumber"), p.employee.socialSecurityNumber)}
      ${kv(ctx.L("workedTime"), p.workedTime)}
    </table>
    ${p.employee.address ? `<div class="small">${esc(p.employee.address)}</div>` : ""}
  </div>
</div>
<h3>${esc(ctx.L("earnings"))}</h3>
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("base"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("amount"))}</th></tr></thead>
<tbody>${items(p.earnings, c)}
<tr class="total"><td colspan="3">${esc(ctx.L("grossPay"))}</td>${td(p.grossPay, c, { zero: "zero" })}</tr></tbody>
</table>
<h3>${esc(ctx.L("contributions"))}</h3>
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("base"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("employeeShare"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("employerShare"))}</th></tr></thead>
<tbody>${contributions}
<tr class="total"><td colspan="3">${esc(ctx.L("totalContributions"))}</td>${td(p.totalEmployeeContributions, c, { zero: "zero" })}<td></td>${td(p.totalEmployerContributions, c, { zero: "zero" })}</tr></tbody>
</table>
<h3>${esc(ctx.L("incomeTax"))}</h3>
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("base"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("amount"))}</th></tr></thead>
<tbody>${items(p.incomeTax, c)}</tbody>
</table>
${p.otherDeductions?.length ? `<h3>${esc(ctx.L("otherDeductions"))}</h3><table class="fin"><tbody>${items(p.otherDeductions, c)}</tbody></table>` : ""}
${p.nonTaxableAllowances?.length ? `<h3>${esc(ctx.L("allowances"))}</h3><table class="fin"><tbody>${items(p.nonTaxableAllowances, c)}</tbody></table>` : ""}
<div class="row">
  <div class="col">
    ${p.cumulative ? `<h3>${esc(ctx.L("cumulative"))}</h3><table class="kv">${kv(ctx.L("grossPay"), fmt(p.cumulative.grossPay, c, { zero: "zero" }))}${kv(ctx.L("incomeTax"), fmt(p.cumulative.incomeTax, c, { zero: "zero" }))}${kv(ctx.L("netPay"), fmt(p.cumulative.netPay, c, { zero: "zero" }))}</table>` : ""}
    ${p.leaveBalanceDays !== undefined ? `<div class="small">${esc(ctx.L("leaveBalance"))} : ${esc(p.leaveBalanceDays)}</div>` : ""}
  </div>
  <div class="col">
    <div class="total-box">${esc(ctx.L("netPay"))} : ${esc(fmt(p.netPay, c, { zero: "zero" }))} ${esc(c)}</div>
    <p class="right small">${esc(ctx.L("employerCost"))} : <b>${esc(fmt(p.employerCost, c, { zero: "zero" }))} ${esc(c)}</b></p>
  </div>
</div>
<p class="small muted">${esc(ctx.L("payslipKeep"))}</p>
${pageFooter(ctx)}
</section>`;
  return layout(ctx, `${ctx.L("payslip")} – ${p.employee.fullName} – ${periodLabel}`, body);
}

function kv(label: string, value: string | undefined): string {
  return value ? `<tr><td class="k">${esc(label)}</td><td>${esc(value)}</td></tr>` : "";
}

function items(rows: PayslipItemView[], currency: string): string {
  return rows.map((r) => `<tr><td>${esc(r.label)}</td>${td(r.base, currency, { zero: "zero" })}<td class="num">${esc(r.rate ?? "")}</td>${td(r.amount, currency, { zero: "zero" })}</tr>`).join("\n");
}
