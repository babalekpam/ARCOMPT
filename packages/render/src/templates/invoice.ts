import { Money } from "@arcompt/ledger";
import { companyBlock, esc, fmt, fmtDate, layout, makeCtx, money, pageFooter, td, type Ctx } from "../html.js";
import type { InvoiceView, PartyView, RenderOptions, VatSummaryView } from "../views.js";

/**
 * Facture de vente (ou avoir / pro forma) avec mentions légales : numéro,
 * dates, identifiants fiscaux des deux parties, lignes HT/TVA/TTC, récapitulatif
 * de TVA, certification électronique (référence + QR), modalités de paiement
 * dont mobile money.
 */
export function renderInvoice(inv: InvoiceView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, inv.currency);
  const c = inv.currency;
  const kind = inv.kind ?? "INVOICE";
  const title = ctx.L(kind === "CREDIT_NOTE" ? "creditNote" : kind === "PROFORMA" ? "proforma" : "invoice");
  const seller = opts.company ? companyBlock(opts.company, ctx) : partyBlock(inv.seller, ctx);

  const lines = inv.lines
    .map(
      (l) => `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td><td class="center">${esc(l.unit ?? "")}</td>${td(l.unitPrice, c, { zero: "zero" })}${td(l.discount, c)}<td class="num">${esc(l.vatRate)} %</td>${td(l.totalHt, c, { zero: "zero" })}${td(l.vatAmount, c, { zero: "zero" })}${td(l.totalTtc, c, { zero: "zero" })}</tr>`,
    )
    .join("\n");

  const vat = (inv.vatSummary ?? vatSummaryFromLines(inv)).map((v) => `<tr><td class="center">${esc(v.rate)} %</td>${td(v.base, c, { zero: "zero" })}${td(v.amount, c, { zero: "zero" })}</tr>`).join("\n");

  const paid = inv.amountPaid !== undefined ? money(inv.amountPaid) : null;
  const remaining = paid ? money(inv.totalTtc).sub(paid) : null;
  const totals = `<table class="fin">
<tr><td>${esc(ctx.L("totalHt"))}</td>${td(inv.totalHt, c, { zero: "zero" })}</tr>
<tr><td>${esc(ctx.L("vat"))}</td>${td(inv.totalVat, c, { zero: "zero" })}</tr>
${(inv.otherTaxes ?? []).map((tx) => `<tr><td>${esc(tx.label)}</td>${td(tx.amount, c, { zero: "zero" })}</tr>`).join("\n")}
<tr class="total"><td>${esc(ctx.L("totalTtc"))}</td>${td(inv.totalTtc, c, { zero: "zero" })}</tr>
${paid ? `<tr><td>${esc(ctx.L("amountPaid"))}</td>${td(paid, c, { zero: "zero" })}</tr><tr class="total"><td>${esc(ctx.L("remaining"))}</td>${td(remaining!, c, { zero: "zero" })}</tr>` : ""}
</table>
<div class="total-box">${esc(ctx.L("netToPay"))} : ${esc(fmt(remaining ?? inv.totalTtc, c, { zero: "zero" }))} ${esc(c)}</div>`;

  const body = `<section class="page">
<header class="doc-header">
  ${seller}
  <div class="meta">
    <div class="doc-title">${esc(title)} ${esc(ctx.L("invoiceNumber"))} ${esc(inv.number)}</div>
    <div>${esc(ctx.L("issueDate"))} : <b>${esc(fmtDate(inv.issueDate, ctx.locale))}</b></div>
    ${inv.dueDate ? `<div>${esc(ctx.L("dueDate"))} : <b>${esc(fmtDate(inv.dueDate, ctx.locale))}</b></div>` : ""}
    ${inv.deliveryDate ? `<div>${esc(ctx.L("deliveryDate"))} : ${esc(fmtDate(inv.deliveryDate, ctx.locale))}</div>` : ""}
    ${inv.reference ? `<div>${esc(ctx.L("orderRef"))} : ${esc(inv.reference)}</div>` : ""}
    <div>${esc(ctx.L("currency"))} : ${esc(c)}</div>
  </div>
</header>
<div class="row">
  <div class="col"></div>
  <div class="col box"><div class="small muted">${esc(ctx.L("buyer"))}</div>${partyBlock(inv.buyer, ctx)}</div>
</div>
<h2>${esc(title)} ${esc(inv.number)}</h2>
<table class="fin">
<thead><tr><th>${esc(ctx.L("description"))}</th><th>${esc(ctx.L("quantity"))}</th><th>${esc(ctx.L("unit"))}</th><th>${esc(ctx.L("unitPrice"))}</th><th>${esc(ctx.L("discount"))}</th><th>${esc(ctx.L("vatRate"))}</th><th>${esc(ctx.L("totalHt"))}</th><th>${esc(ctx.L("vat"))}</th><th>${esc(ctx.L("totalTtc"))}</th></tr></thead>
<tbody>${lines}</tbody>
</table>
<div class="row">
  <div class="col">
    <h3>${esc(ctx.L("vat"))}</h3>
    <table class="fin"><thead><tr><th>${esc(ctx.L("vatRate"))}</th><th>${esc(ctx.L("vatBase"))}</th><th>${esc(ctx.L("vat"))}</th></tr></thead><tbody>${vat}</tbody></table>
    ${paymentBlock(inv, ctx)}
  </div>
  <div class="col">${totals}${certificationBlock(inv, ctx)}</div>
</div>
${inv.notes ? `<p class="small">${esc(inv.notes)}</p>` : ""}
${inv.legalMentions?.length ? `<h3>${esc(ctx.L("legalMentions"))}</h3><ul class="legal">${inv.legalMentions.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
${pageFooter(ctx)}
</section>`;
  return layout(ctx, `${title} ${inv.number}`, body);
}

function partyBlock(p: PartyView, _ctx: Ctx): string {
  const ids = (p.identifiers ?? []).map((i) => `<span class="id"><b>${esc(i.label)}</b> ${esc(i.value)}</span>`).join(" · ");
  const address = [p.address, [p.city, p.country].filter(Boolean).join(", ")].filter(Boolean).map(esc).join("<br>");
  const contact = [p.phone, p.email].filter(Boolean).map(esc).join(" · ");
  return `<div class="party"><div class="company-name">${esc(p.name)}</div>${ids ? `<div class="small ids">${ids}</div>` : ""}${address ? `<div class="small">${address}</div>` : ""}${contact ? `<div class="small">${contact}</div>` : ""}</div>`;
}

function paymentBlock(inv: InvoiceView, ctx: Ctx): string {
  const p = inv.payment;
  if (!p) return "";
  const bank = p.bank
    ? `<div><b>${esc(ctx.L("bankTransfer"))}</b> : ${esc(p.bank.bankName)}${p.bank.holder ? ` – ${esc(ctx.L("holder"))} ${esc(p.bank.holder)}` : ""}<br>${p.bank.iban ? `IBAN ${esc(p.bank.iban)} ` : ""}${p.bank.rib ? `RIB ${esc(p.bank.rib)} ` : ""}${p.bank.bic ? `BIC ${esc(p.bank.bic)}` : ""}</div>`
    : "";
  const momo = p.mobileMoney?.length
    ? `<div><b>${esc(ctx.L("mobileMoney"))}</b> : ${p.mobileMoney.map((m) => `${esc(m.operator)} ${esc(m.number)}${m.holder ? ` (${esc(m.holder)})` : ""}`).join(" · ")}</div>`
    : "";
  return `<h3>${esc(ctx.L("paymentTerms"))}</h3><div class="small">${p.terms ? `<div>${esc(p.terms)}</div>` : ""}${bank}${momo}</div>`;
}

function certificationBlock(inv: InvoiceView, ctx: Ctx): string {
  const cert = inv.certification;
  if (!cert) return "";
  const qr = cert.qrDataUri ? `<div class="qr"><img src="${esc(cert.qrDataUri)}" alt="QR"></div>` : `<div class="qr">${esc(ctx.L("qrPlaceholder"))}${cert.qrData ? `<br>${esc(cert.qrData.slice(0, 60))}` : ""}</div>`;
  return `<div class="row" style="margin-top:8px"><div class="col small"><b>${esc(ctx.L("certification"))}</b>${cert.system ? ` – ${esc(cert.system)}` : ""}<br>${cert.reference ? `${esc(ctx.L("certificationRef"))} : <b>${esc(cert.reference)}</b><br>` : ""}${cert.verifyUrl ? `${esc(ctx.L("verify"))} : ${esc(cert.verifyUrl)}` : ""}</div>${qr}</div>`;
}

/** Récapitulatif de TVA par taux, recalculé depuis les lignes. */
export function vatSummaryFromLines(inv: InvoiceView): VatSummaryView[] {
  const byRate = new Map<string, { base: Money; amount: Money }>();
  for (const l of inv.lines) {
    const cur = byRate.get(l.vatRate) ?? { base: Money.zero(), amount: Money.zero() };
    byRate.set(l.vatRate, { base: cur.base.add(money(l.totalHt)), amount: cur.amount.add(money(l.vatAmount)) });
  }
  return [...byRate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rate, v]) => ({ rate, base: v.base, amount: v.amount }));
}
