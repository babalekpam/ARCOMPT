// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { companyBlock, esc, layout, makeCtx, pageFooter, td, type Ctx } from "../html.js";
import type { PayslipItemView, PayslipView, RenderOptions } from "../views.js";

/**
 * Bulletin de paie : identification employeur/salarié, éléments de
 * rémunération jusqu'au brut, cotisations (parts salariale et patronale),
 * impôt sur salaires, net à payer et coût employeur.
 *
 * Le lecteur est le SALARIÉ : la langue du bulletin est la sienne, pas celle
 * du gestionnaire de paie. Les taux fournis par le module de paie sont
 * re-ponctués (« 6,3 % » devient « 6.3% » en anglais) ; les libellés de
 * cotisation, eux, restent tels que le pack pays les nomme, parce qu'ils
 * désignent des organismes réels (CNPS, CNSS, ITS) qui n'ont pas de traduction.
 */
export function renderPayslip(p: PayslipView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, p.currency);
  const periodLabel = p.period.label ?? `${ctx.d(p.period.start)} – ${ctx.d(p.period.end)}`;

  const contributions = p.contributions
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td>${td(ctx, r.base, { zero: "zero" })}<td class="num">${esc(ctx.rate(r.employeeRate))}</td>${td(ctx, r.employeeAmount, { zero: "zero" })}<td class="num">${esc(ctx.rate(r.employerRate))}</td>${td(ctx, r.employerAmount, { zero: "zero" })}</tr>`,
    )
    .join("\n");

  const body = `<section class="page">
<header class="doc-header">
  ${companyBlock(opts.company, ctx)}
  <div class="meta">
    <div class="doc-title">${esc(ctx.L("payslip"))}</div>
    <div>${ctx.kv(esc(ctx.L("period")), `<b>${esc(periodLabel)}</b>`)}</div>
    ${p.paymentDate ? `<div>${ctx.kv(esc(ctx.L("paymentDate")), esc(ctx.d(p.paymentDate)))}</div>` : ""}
    ${p.paymentMode ? `<div>${ctx.kv(esc(ctx.L("paymentMode")), esc(p.paymentMode))}</div>` : ""}
    <div>${ctx.kv(esc(ctx.L("currency")), esc(ctx.currency))}</div>
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
      ${kv(ctx.L("hireDate"), p.employee.hireDate ? ctx.d(p.employee.hireDate) : undefined)}
      ${kv(ctx.L("socialSecurityNumber"), p.employee.socialSecurityNumber)}
      ${kv(ctx.L("workedTime"), p.workedTime)}
    </table>
    ${p.employee.address ? `<div class="small">${esc(p.employee.address)}</div>` : ""}
  </div>
</div>
<h3>${esc(ctx.L("earnings"))}</h3>
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("base"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("amount"))}</th></tr></thead>
<tbody>${items(ctx, p.earnings)}
<tr class="total"><td colspan="3">${esc(ctx.L("grossPay"))}</td>${td(ctx, p.grossPay, { zero: "zero" })}</tr></tbody>
</table>
<h3>${esc(ctx.L("contributions"))}</h3>
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("base"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("employeeShare"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("employerShare"))}</th></tr></thead>
<tbody>${contributions}
<tr class="total"><td colspan="3">${esc(ctx.L("totalContributions"))}</td>${td(ctx, p.totalEmployeeContributions, { zero: "zero" })}<td></td>${td(ctx, p.totalEmployerContributions, { zero: "zero" })}</tr></tbody>
</table>
<h3>${esc(ctx.L("incomeTax"))}</h3>
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("base"))}</th><th>${esc(ctx.L("rate"))}</th><th>${esc(ctx.L("amount"))}</th></tr></thead>
<tbody>${items(ctx, p.incomeTax)}</tbody>
</table>
${p.otherDeductions?.length ? `<h3>${esc(ctx.L("otherDeductions"))}</h3><table class="fin"><tbody>${items(ctx, p.otherDeductions)}</tbody></table>` : ""}
${p.nonTaxableAllowances?.length ? `<h3>${esc(ctx.L("allowances"))}</h3><table class="fin"><tbody>${items(ctx, p.nonTaxableAllowances)}</tbody></table>` : ""}
<div class="row">
  <div class="col">
    ${p.cumulative ? `<h3>${esc(ctx.L("cumulative"))}</h3><table class="kv">${kv(ctx.L("grossPay"), ctx.n(p.cumulative.grossPay, { zero: "zero" }))}${kv(ctx.L("incomeTax"), ctx.n(p.cumulative.incomeTax, { zero: "zero" }))}${kv(ctx.L("netPay"), ctx.n(p.cumulative.netPay, { zero: "zero" }))}</table>` : ""}
    ${p.leaveBalanceDays !== undefined ? `<div class="small">${esc(ctx.kv(ctx.L("leaveBalance"), ctx.rate(p.leaveBalanceDays)))}</div>` : ""}
  </div>
  <div class="col">
    <div class="total-box">${esc(ctx.kv(ctx.L("netPay"), ctx.m(p.netPay, { zero: "zero" })))}</div>
    <p class="right small">${ctx.kv(esc(ctx.L("employerCost")), `<b>${esc(ctx.m(p.employerCost, { zero: "zero" }))}</b>`)}</p>
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

function items(ctx: Ctx, rows: PayslipItemView[]): string {
  return rows.map((r) => `<tr><td>${esc(r.label)}</td>${td(ctx, r.base, { zero: "zero" })}<td class="num">${esc(ctx.rate(r.rate))}</td>${td(ctx, r.amount, { zero: "zero" })}</tr>`).join("\n");
}
