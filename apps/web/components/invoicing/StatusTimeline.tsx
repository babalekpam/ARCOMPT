// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { formatDate, type Locale, type Translator } from "@/lib/i18n";
import { Money } from "@/components/ui/Money";
import type { Payment, PurchaseDocument, SalesDocument } from "./types";

interface Step {
  key: string;
  label: string;
  date: string | null;
  detail?: React.ReactNode;
  tone: "done" | "current" | "danger";
}

/**
 * Chronologie d'un document (composant serveur) : création, émission
 * (numéro, écriture), certification, règlements affectés, solde ou annulation.
 */
export function StatusTimeline({ doc, payments, t, locale }: { doc: SalesDocument | PurchaseDocument; payments: Payment[]; t: Translator; locale: Locale }) {
  const isSales = "certification" in doc;
  const steps: Step[] = [{ key: "created", label: t("invoicing.timeline.created"), date: doc.createdAt.slice(0, 10), tone: "done" }];
  if (doc.number) {
    steps.push({
      key: "issued",
      label: t("invoicing.timeline.issued"),
      date: doc.issueDate,
      detail: (
        <>
          <span className="font-mono">{doc.number}</span>
          {doc.entryId ? <span className="ml-2 font-mono text-[11px] text-slate-400">{t("invoicing.timeline.entry")} {doc.entryId.slice(0, 8)}…</span> : null}
        </>
      ),
      tone: "done",
    });
  }
  if (isSales && doc.certification) {
    steps.push({ key: "certified", label: t("invoicing.timeline.certified"), date: doc.certification.certifiedAt.slice(0, 10), detail: <span className="font-mono text-xs">{doc.certification.system} · {doc.certification.reference}</span>, tone: "done" });
  }
  const mine = payments
    .filter((p) => p.status === "RECORDED" && p.allocations.some((a) => (isSales ? a.salesDocumentId === doc.id : a.purchaseDocumentId === doc.id)))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const p of mine) {
    const alloc = p.allocations.filter((a) => (isSales ? a.salesDocumentId === doc.id : a.purchaseDocumentId === doc.id));
    steps.push({
      key: p.id,
      label: t("invoicing.timeline.payment"),
      date: p.date,
      detail: (
        <>
          <span className="font-mono">{p.number}</span> · {t(`invoicing.method.${p.method}`)} · {alloc.map((a) => <Money key={a.id} value={a.amount} currency={doc.currency} className="ml-1" />)}
        </>
      ),
      tone: "done",
    });
  }
  if (doc.status === "PAID") steps.push({ key: "paid", label: t("invoicing.timeline.paid"), date: null, tone: "done" });
  else if (doc.status === "CANCELLED") steps.push({ key: "cancelled", label: t("invoicing.timeline.cancelled"), date: doc.updatedAt.slice(0, 10), tone: "danger" });
  else if (isSales && doc.status === "ACCEPTED") steps.push({ key: "accepted", label: t("invoicing.timeline.accepted"), date: doc.updatedAt.slice(0, 10), tone: "done" });
  else if (isSales && doc.status === "REFUSED") steps.push({ key: "refused", label: t("invoicing.timeline.refused"), date: doc.updatedAt.slice(0, 10), tone: "danger" });
  else steps.push({ key: "now", label: t(`invoicing.status.${doc.status}`), date: null, tone: "current", detail: doc.outstanding !== "0.0000" && doc.number ? <>{t("invoicing.timeline.outstanding")} <Money value={doc.outstanding} currency={doc.currency} className="font-semibold" /></> : undefined });

  return (
    <ol className="relative ml-2 border-l border-slate-200 pl-4 dark:border-slate-800">
      {steps.map((s) => (
        <li key={s.key} className="mb-3 last:mb-0">
          <span className={`absolute -left-[5px] mt-1.5 block h-2.5 w-2.5 rounded-full ${s.tone === "done" ? "bg-emerald-500" : s.tone === "danger" ? "bg-red-500" : "bg-amber-400"}`} aria-hidden />
          <div className="text-sm font-medium">{s.label}</div>
          <div className="text-xs text-slate-500">
            {s.date ? formatDate(locale, s.date) : ""}
            {s.detail ? <span className="ml-1">{s.detail}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
