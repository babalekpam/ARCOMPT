// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Badge } from "@/components/ui/Badge";
import { Money } from "@/components/ui/Money";
import { confidenceTone, formatConfidence } from "./helpers";
import type { DocumentExtraction, GuardIssue } from "./types";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-right text-sm">{value ?? "—"}</dd>
    </div>
  );
}

/** Extraction IA d'une pièce : fournisseur, date, HT/TVA/TTC, confiance et contrôles. Jamais une vérité comptable. */
export function ExtractionCard({ extraction, issues = [], needsOcr = false, fallbackCurrency }: { extraction: DocumentExtraction | null; issues?: GuardIssue[]; needsOcr?: boolean; fallbackCurrency: string }) {
  const { t, locale } = useI18n();
  if (!extraction) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700">
        {needsOcr ? t("documents.extraction.needsOcr") : t("documents.extraction.none")}
      </div>
    );
  }
  const currency = extraction.currency ?? fallbackCurrency;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{t("documents.extraction.title")}</h3>
        <div className="flex items-center gap-2">
          <Badge tone="info">{t(`documents.doctype.${extraction.document_type}`)}</Badge>
          <Badge tone={confidenceTone(extraction.confidence)}>
            {t("documents.extraction.confidence")} {formatConfidence(extraction.confidence)}
          </Badge>
        </div>
      </div>
      {needsOcr ? <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t("documents.extraction.needsOcr")}</p> : null}
      <dl className="divide-y divide-slate-100 dark:divide-slate-800">
        <Row label={t("documents.extraction.supplier")} value={extraction.supplier_name} />
        {extraction.supplier_tax_id ? <Row label={t("documents.extraction.taxId")} value={<span className="font-mono text-xs">{extraction.supplier_tax_id}</span>} /> : null}
        {extraction.customer_name ? <Row label={t("documents.extraction.customer")} value={extraction.customer_name} /> : null}
        <Row label={t("documents.extraction.reference")} value={extraction.reference} />
        <Row label={t("documents.extraction.date")} value={formatDate(locale, extraction.date) || "—"} />
        <Row label={t("documents.extraction.ht")} value={extraction.amount_excl_tax ? <Money value={extraction.amount_excl_tax} currency={currency} showCurrency /> : null} />
        <Row label={t("documents.extraction.tva")} value={extraction.vat_amount ? <Money value={extraction.vat_amount} currency={currency} showCurrency /> : null} />
        <Row label={t("documents.extraction.ttc")} value={extraction.amount_incl_tax ? <Money value={extraction.amount_incl_tax} currency={currency} showCurrency className="font-semibold" /> : null} />
      </dl>
      {extraction.lines.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-slate-500">{t("documents.extraction.lines", { n: extraction.lines.length })}</summary>
          <ul className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
            {extraction.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2 py-1">
                <span className="truncate">{l.description}</span>
                <span className="tabular-nums">{l.amount ? <Money value={l.amount} currency={currency} /> : "—"}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {extraction.notes ? <p className="mt-2 text-xs text-slate-500">{extraction.notes}</p> : null}
      {issues.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("documents.extraction.issues")}</p>
          <ul className="mt-1 space-y-1">
            {issues.map((i, k) => (
              <li key={`${i.code}-${k}`} className="flex items-start gap-2 text-xs">
                <Badge tone="warning">{i.code}</Badge>
                <span>{i.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
