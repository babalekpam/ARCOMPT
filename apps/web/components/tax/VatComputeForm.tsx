"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { parseAmount } from "@/components/payroll/helpers";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import type { TaxReturn, VatReturnComputation } from "./types";

/** Calcul d'une déclaration de TVA sur une période (POST /tax/vat/returns/compute) puis ouverture du détail. */
export function VatComputeForm() {
  const t = useT();
  const router = useRouter();
  const today = new Date();
  const first = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 0)).toISOString().slice(0, 10);
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(last);
  const [previousCredit, setPreviousCredit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let credit: string | undefined;
    if (previousCredit.trim()) {
      const v = parseAmount(previousCredit, { allowZero: true });
      if (!v) return setError(t("tax.vat.errorCredit"));
      credit = v;
    }
    setBusy(true);
    try {
      const res = await apiClient<{ taxReturn: TaxReturn; computation: VatReturnComputation }>("/tax/vat/returns/compute", { method: "POST", body: { from, to, ...(credit !== undefined ? { previousCredit: credit } : {}) } });
      router.push(`/tax/vat/${res.taxReturn.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t("common.from")}>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
        </Field>
        <Field label={t("common.to")}>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
        </Field>
        <Field label={`${t("tax.vat.previousCredit")} (${t("common.optional")})`} hint={t("tax.vat.previousCreditHint")}>
          <Input value={previousCredit} onChange={(e) => setPreviousCredit(e.target.value)} inputMode="decimal" className="text-right font-mono" />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" disabled={busy}>
        {busy ? t("common.loading") : t("tax.vat.compute")}
      </Button>
    </form>
  );
}
