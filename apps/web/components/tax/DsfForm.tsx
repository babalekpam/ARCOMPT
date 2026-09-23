// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n-client";
import { parseAmount } from "@/components/payroll/helpers";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";

/**
 * Paramètres de la DSF : exercice, exercice précédent, réintégrations et
 * déductions extra-comptables. Portés par l'URL (`fy`, `prev`, `reintegrations`,
 * `deductions`) : la page serveur recalcule à chaque changement.
 */
export function DsfForm({ fiscalYear, previous, reintegrations, deductions }: { fiscalYear: string; previous: string; reintegrations: string; deductions: string }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [fy, setFy] = useState(fiscalYear);
  const [prev, setPrev] = useState(previous);
  const [re, setRe] = useState(reintegrations === "0" ? "" : reintegrations);
  const [de, setDe] = useState(deductions === "0" ? "" : deductions);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = re.trim() ? parseAmount(re, { allowZero: true }) : "0";
    const d = de.trim() ? parseAmount(de, { allowZero: true }) : "0";
    if (!r || !d) return setError(t("tax.dsf.errorAmounts"));
    const next = new URLSearchParams(params.toString());
    next.set("fy", fy.trim());
    if (prev.trim()) next.set("prev", prev.trim());
    else next.delete("prev");
    if (r !== "0") next.set("reintegrations", r);
    else next.delete("reintegrations");
    if (d !== "0") next.set("deductions", d);
    else next.delete("deductions");
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t("common.fiscalYear")}>
          <Input value={fy} onChange={(e) => setFy(e.target.value)} inputMode="numeric" required />
        </Field>
        <Field label={`${t("common.n1")} (${t("common.optional")})`}>
          <Input value={prev} onChange={(e) => setPrev(e.target.value)} inputMode="numeric" placeholder="—" />
        </Field>
        <Field label={t("tax.dsf.reintegrations")} hint={t("tax.dsf.reintegrationsHint")}>
          <Input value={re} onChange={(e) => setRe(e.target.value)} inputMode="decimal" className="text-right font-mono" placeholder="0" />
        </Field>
        <Field label={t("tax.dsf.deductions")} hint={t("tax.dsf.deductionsHint")}>
          <Input value={de} onChange={(e) => setDe(e.target.value)} inputMode="decimal" className="text-right font-mono" placeholder="0" />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" variant="secondary">
        {t("tax.dsf.recompute")}
      </Button>
    </form>
  );
}
