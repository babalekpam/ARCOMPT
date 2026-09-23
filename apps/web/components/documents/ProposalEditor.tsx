// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n-client";
import { normalizeInput } from "@/lib/money";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { AccountSearch } from "./AccountSearch";
import { buildCorrection, proposalTotals, toEditableLines, type CorrectionError, type EditableLine } from "./helpers";
import type { ProposalLine } from "./types";

let seq = 0;
const blank = (): EditableLine => ({ key: `n${++seq}`, account_number: "", label: "", debit: "", credit: "", vat_code: "" });

const ERROR_KEY: Record<CorrectionError, string> = {
  MIN_LINES: "documents.review.min2",
  ACCOUNT: "documents.review.errorLines",
  AMOUNT: "documents.review.errorLines",
  UNBALANCED: "documents.review.unbalanced",
};

/** Correction des lignes d'une proposition avant comptabilisation (compte, libellé, débit / crédit, TVA). */
export function ProposalEditor({ lines: initial, currency, busy = false, onSubmit, onCancel }: { lines: ProposalLine[]; currency: string; busy?: boolean; onSubmit: (lines: ProposalLine[]) => void; onCancel: () => void }) {
  const t = useT();
  const [lines, setLines] = useState<EditableLine[]>(() => toEditableLines(initial));
  const [error, setError] = useState<string | null>(null);
  const update = (key: string, patch: Partial<EditableLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const totals = useMemo(() => proposalTotals(lines.map((l) => ({ debit: normalizeInput(l.debit) ?? undefined, credit: normalizeInput(l.credit) ?? undefined }))), [lines]);

  const submit = () => {
    const r = buildCorrection(lines);
    if (!r.ok) return setError(t(ERROR_KEY[r.error]));
    setError(null);
    onSubmit(r.lines);
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-300 p-3 dark:border-slate-700">
      <div className="hidden grid-cols-[minmax(8rem,1.2fr)_2fr_1fr_1fr_5rem_auto] gap-2 text-xs uppercase tracking-wide text-slate-500 sm:grid">
        <span>{t("documents.proposal.account")}</span>
        <span>{t("common.label")}</span>
        <span className="text-right">{t("common.debit")}</span>
        <span className="text-right">{t("common.credit")}</span>
        <span>{t("documents.review.vat")}</span>
        <span />
      </div>
      {lines.map((l) => (
        <div key={l.key} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-[minmax(8rem,1.2fr)_2fr_1fr_1fr_5rem_auto] sm:border-0 sm:p-0 dark:border-slate-800">
          <div className="col-span-2 sm:col-span-1">
            <AccountSearch value={l.account_number} onChange={(n) => update(l.key, { account_number: n })} />
          </div>
          <Input value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} placeholder={t("common.label")} maxLength={200} className="col-span-2 sm:col-span-1" />
          <Input value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })} placeholder={t("common.debit")} inputMode="decimal" className="text-right font-mono" />
          <Input value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, ...(e.target.value ? { debit: "" } : {}) })} placeholder={t("common.credit")} inputMode="decimal" className="text-right font-mono" />
          <Input value={l.vat_code} onChange={(e) => update(l.key, { vat_code: e.target.value })} placeholder={t("documents.review.vat")} maxLength={20} className="font-mono text-xs" />
          <Button variant="ghost" size="sm" onClick={() => setLines((ls) => (ls.length > 2 ? ls.filter((x) => x.key !== l.key) : ls))} disabled={lines.length <= 2} aria-label={t("documents.review.removeLine")}>
            ✕
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>+ {t("documents.review.addLine")}</Button>
        <span>
          {t("common.debit")} <Money value={totals.debit} currency={currency} className="font-semibold" /> · {t("common.credit")} <Money value={totals.credit} currency={currency} className="font-semibold" />{" "}
          {totals.balanced ? <span className="text-emerald-700 dark:text-emerald-300">{t("documents.review.balanced")}</span> : <span className="text-amber-700 dark:text-amber-300">{t("documents.review.unbalanced")}</span>}
        </span>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={submit} disabled={busy}>{busy ? t("common.loading") : t("documents.review.saveCorrection")}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>{t("documents.review.cancelEdit")}</Button>
      </div>
    </div>
  );
}
