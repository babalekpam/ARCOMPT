"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import type { PayrollRun } from "./types";

/** Ouverture d'un cycle de paie (année + mois) puis redirection vers sa fiche. */
export function NewRunForm({ defaultYear }: { defaultYear: number }) {
  const t = useT();
  const router = useRouter();
  const now = new Date();
  const [year, setYear] = useState(String(defaultYear));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const run = await apiClient<PayrollRun>("/payroll/runs", { method: "POST", body: { year: Number(year), month: Number(month) } });
      router.push(`/payroll/runs/${run.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-slate-500">
        {t("payroll.year")}
        <Input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" className="mt-1 w-24" required />
      </label>
      <label className="text-xs text-slate-500">
        {t("payroll.month")}
        <Select value={month} onChange={(e) => setMonth(e.target.value)} className="mt-1 w-40">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={String(n)}>
              {t(`payroll.months.${n}`)}
            </option>
          ))}
        </Select>
      </label>
      <Button type="submit" disabled={busy}>
        {busy ? t("common.loading") : t("payroll.runs.open")}
      </Button>
      {error ? <Alert tone="danger" className="basis-full">{error}</Alert> : null}
    </form>
  );
}
