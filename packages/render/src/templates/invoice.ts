import { Money } from "@arcompt/ledger";
import { companyBlock, esc, layout, makeCtx, money, pageFooter, td, type Ctx } from "../html.js";
import type { InvoiceView, PartyView, RenderOptions, VatSummaryView } from "../views.js";

/**
 * Facture de vente (ou avoir / pro forma) avec mentions légales : numéro,
 * dates, identifiants fiscaux des deux parties, lignes HT/TVA/TTC, récapitulatif
 * de TVA, certification électronique (référence + QR), modalités de paiement
 * dont mobile money.
 *
 * C'est la pièce la plus sensible à la langue de tout le produit : elle sort
 * de l'entreprise. Sa langue est celle du CLIENT (`RenderOptions.locale`,
 * résolu par `resolveLocale` avec la langue du tiers en tête), jamais celle du
 * comptable qui l'édite.
 */
export function renderInvoice(inv: InvoiceView, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, inv.currency);
  const kind = inv.kind ?? "INVOICE";
  const title = ctx.L(kind === "CREDIT_NOTE" ? "creditNote" : kind === "PROFORMA" ? "proforma" : "invoice");
  const seller = opts.company ? companyBlock(opts.company, ctx) : partyBlock(inv.seller, ctx);

  const lines = inv.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="num">${esc(ctx.rate(l.quantity))}</td><td class="center">${esc(l.unit ?? "")}</td>${td(ctx, l.unitPrice, { zero: "zero" })}${td(ctx, l.discount)}<td class="num">${esc(ctx.pct(l.vatRate))}</td>${td(ctx, l.totalHt, { zero: "zero" })}${td(ctx, l.vatAmount, { zero: "zero" })}${td(ctx, l.totalTtc, { zero: "zero" })}</tr>`,
    )
    .join("\n");

  const vat = (inv.vatSummary ?? vatSummaryFromLines(inv))
    .map((v) => `<tr><td class="center">${esc(ctx.pct(v.rate))}</td>${td(ctx, v.base, { zero: "zero" })}${td(ctx, v.amount, { zero: "zero" })}</tr>`)
    .join("\n");

  const paid = inv.amountPaid !== undefined ? money(inv.amountPaid) : null;
  const remaining = paid ? money(inv.totalTtc).sub(paid) : null;
  const totals = `<table class="fin">
<tr><td>${esc(ctx.L("totalHt"))}</td>${td(ctx, inv.totalHt, { zero: "zero" })}</tr>
<tr><td>${esc(ctx.L("vat"))}</td>${td(ctx, inv.totalVat, { zero: "zero" })}</tr>
${(inv.otherTaxes ?? []).map((tx) => `<tr><td>${esc(tx.label)}</td>${td(ctx, tx.amount, { zero: "zero" })}</tr>`).join("\n")}
<tr class="total"><td>${esc(ctx.L("totalTtc"))}</td>${td(ctx, inv.totalTtc, { zero: "zero" })}</tr>
${paid ? `<tr><td>${esc(ctx.L("amountPaid"))}</td>${td(ctx, paid, { zero: "zero" })}</tr><tr class="total"><td>${esc(ctx.L("remaining"))}</td>${td(ctx, remaining!, { zero: "zero" })}</tr>` : ""}
</table>
<div class="total-box">${esc(ctx.kv(ctx.L("netToPay"), ctx.m(remaining ?? inv.totalTtc, { zero: "zero" })))}</div>`;

  const body = `<section class="page">
<header class="doc-header">
  ${seller}
  <div class="meta">
    <div class="doc-title">${esc(title)} ${esc(ctx.L("invoiceNumber"))} ${esc(inv.number)}</div>
    <div>${ctx.kv(esc(ctx.L("issueDate")), `<b>${esc(ctx.d(inv.issueDate))}</b>`)}</div>
    ${inv.dueDate ? `<div>${ctx.kv(esc(ctx.L("dueDate")), `<b>${esc(ctx.d(inv.dueDate))}</b>`)}</div>` : ""}
    ${inv.deliveryDate ? `<div>${ctx.kv(esc(ctx.L("deliveryDate")), esc(ctx.d(inv.deliveryDate)))}</div>` : ""}
    ${inv.reference ? `<div>${ctx.kv(esc(ctx.L("orderRef")), esc(inv.reference))}</div>` : ""}
    <div>${ctx.kv(esc(ctx.L("currency")), esc(ctx.currency))}</div>
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
    ? `<div>${ctx.kv(`<b>${esc(ctx.L("bankTransfer"))}</b>`, esc(p.bank.bankName))}${p.bank.holder ? ` – ${esc(ctx.L("holder"))} ${esc(p.bank.holder)}` : ""}<br>${p.bank.iban ? `IBAN ${esc(p.bank.iban)} ` : ""}${p.bank.rib ? `RIB ${esc(p.bank.rib)} ` : ""}${p.bank.bic ? `BIC ${esc(p.bank.bic)}` : ""}</div>`
    : "";
  const momo = p.mobileMoney?.length
    ? `<div>${ctx.kv(`<b>${esc(ctx.L("mobileMoney"))}</b>`, p.mobileMoney.map((m) => `${esc(m.operator)} ${esc(m.number)}${m.holder ? ` (${esc(m.holder)})` : ""}`).join(" · "))}</div>`
    : "";
  return `<h3>${esc(ctx.L("paymentTerms"))}</h3><div class="small">${p.terms ? `<div>${esc(p.terms)}</div>` : ""}${bank}${momo}</div>`;
}

function certificationBlock(inv: InvoiceView, ctx: Ctx): string {
  const cert = inv.certification;
  if (!cert) return "";
  const qr = cert.qrDataUri ? `<div class="qr"><img src="${esc(cert.qrDataUri)}" alt="QR"></div>` : `<div class="qr">${esc(ctx.L("qrPlaceholder"))}${cert.qrData ? `<br>${esc(cert.qrData.slice(0, 60))}` : ""}</div>`;
  return `<div class="row" style="margin-top:8px"><div class="col small"><b>${esc(ctx.L("certification"))}</b>${cert.system ? ` – ${esc(cert.system)}` : ""}<br>${cert.reference ? `${ctx.kv(esc(ctx.L("certificationRef")), `<b>${esc(cert.reference)}</b>`)}<br>` : ""}${cert.verifyUrl ? ctx.kv(esc(ctx.L("verify")), esc(cert.verifyUrl)) : ""}</div>${qr}</div>`;
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
