// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useState } from "react";
import { apiClient, errorMessage, useMutation } from "@/lib/api-client";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import type { PdfData } from "./types";

/** Données de rendu PDF (GET /v1/sales/:id/pdf-data), chargées à la demande : émetteur, client, récapitulatif TVA, certification. */
export function PdfDataView({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const [shown, setShown] = useState(false);
  const m = useMutation((docId: string) => apiClient<PdfData>(`/sales/${docId}/pdf-data`));
  const load = () => {
    setShown(true);
    void m.mutate(id);
  };
  if (!shown) {
    return (
      <Button variant="secondary" size="sm" onClick={load}>
        {t("invoicing.pdf.show")}
      </Button>
    );
  }
  if (m.status === "loading" || m.status === "idle") return <p className="text-xs text-slate-500">{t("common.loading")}</p>;
  if (m.status === "error") return <Alert tone="danger">{errorMessage(m.error)}</Alert>;
  const d = m.data!;
  const currency = d.document.currency;
  const contact = d.partner.contact as Record<string, string | undefined>;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("invoicing.pdf.issuer")}</p>
          <p className="font-medium">{d.company.name}</p> {d.company.logoDataUri ? <img src={d.company.logoDataUri} alt="Logo" className="mt-1 h-10 object-contain" /> : null}
          <p className="text-xs text-slate-500">
            {d.company.countryCode} · {d.company.currency}
            {(d.company.address || d.company.city || d.company.phone) ? <span>{d.company.address ?? ""} {d.company.city ?? ""} {d.company.phone ?? ""} · </span> : null} {Object.entries(d.company.taxIds).map(([k, v]) => ` · ${k} ${v}`)}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("invoicing.pdf.recipient")}</p>
          <p className="font-medium">{d.partner.name}</p>
          <p className="text-xs text-slate-500">
            {d.partner.taxId ? `${t("invoicing.partner.taxId")} ${d.partner.taxId}` : ""}
            {contact.phone ? ` · ${contact.phone}` : ""}
            {contact.email ? ` · ${contact.email}` : ""}
            {contact.address ? ` · ${contact.address}` : ""}
          </p>
        </div>
      </div>
      {d.source ? <p className="text-xs text-slate-500">{t("invoicing.pdf.source", { kind: t(`invoicing.kind.${d.source.kind}`), number: d.source.number })}</p> : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <th className="py-1 pr-3">{t("invoicing.form.vat")}</th>
            <th className="py-1 pr-3 text-right">{t("invoicing.pdf.rate")}</th>
            <th className="py-1 pr-3 text-right">{t("invoicing.pdf.base")}</th>
            <th className="py-1 text-right">{t("invoicing.form.vatTotal")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {d.vatSummary.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-1 text-xs text-slate-500">{t("invoicing.pdf.noVat")}</td>
            </tr>
          ) : null}
          {d.vatSummary.map((r) => (
            <tr key={r.vatCode}>
              <td className="py-1 pr-3 font-mono text-xs">{r.vatCode}</td>
              <td className="py-1 pr-3 text-right">{r.rate}</td>
              <td className="py-1 pr-3 text-right"><Money value={r.base} currency={currency} /></td>
              <td className="py-1 text-right"><Money value={r.vat} currency={currency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-slate-500">
        {t("invoicing.pdf.pack", { code: d.pack.code.toUpperCase() })}
        {d.pack.certifiedInvoiceSystem ? ` · ${t("invoicing.pdf.certifiedSystem", { system: d.pack.certifiedInvoiceSystem })}` : ""}
      </p>
      {d.certification ? (
        <Alert tone="success">
          {t("invoicing.pdf.certified", { system: d.certification.system, reference: d.certification.reference, date: formatDate(locale, d.certification.certifiedAt.slice(0, 10)) })}
          <span className="mt-1 block break-all font-mono text-[11px]">{d.certification.qrCode}</span>
        </Alert>
      ) : null}
    </div>
  );
}
