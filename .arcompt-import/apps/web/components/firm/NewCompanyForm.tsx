// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import type { PackSummary } from "@/lib/types";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { defaultFiscalYear } from "./helpers";
import type { CompanySummary } from "./types";

/** « Nouveau dossier » : nom, pack pays, devise, système, exercice (POST /portal/org/companies). */
export function NewCompanyForm({ packs, defaultCurrency }: { packs: PackSummary[]; defaultCurrency: string }) {
  const t = useT();
  const router = useRouter();
  const fy = defaultFiscalYear(new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [packCode, setPackCode] = useState(packs[0]?.code ?? "ci");
  const [currency, setCurrency] = useState(packs[0]?.currency ?? defaultCurrency);
  const [system, setSystem] = useState<"NORMAL" | "SMT">("NORMAL");
  const [code, setCode] = useState(fy.code);
  const [startDate, setStartDate] = useState(fy.startDate);
  const [endDate, setEndDate] = useState(fy.endDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CompanySummary | null>(null);

  const choosePack = (c: string) => {
    setPackCode(c);
    const p = packs.find((x) => x.code === c);
    if (p?.currency) setCurrency(p.currency);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const company = await apiClient<CompanySummary>("/portal/org/companies", {
        method: "POST",
        body: { name: name.trim(), countryCode: packCode.slice(0, 2).toUpperCase(), packCode, currency: currency.toUpperCase(), accountingSystem: system, fiscalYear: { code: code.trim(), startDate, endDate } },
      });
      setCreated(company);
      setName("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="space-y-2">
        <Button size="sm" onClick={() => setOpen(true)}>{t("firm.companies.new")}</Button>
        {created ? <Alert tone="success">{t("firm.companies.created", { name: created.name })} <span className="font-mono text-xs">{created.id}</span></Alert> : null}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-xl border border-slate-300 p-3 dark:border-slate-700">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("firm.companies.name")} className="sm:col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <Field label={t("firm.companies.pack")}>
          {packs.length > 0 ? (
            <Select value={packCode} onChange={(e) => choosePack(e.target.value)}>
              {packs.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.code.toUpperCase()} — {p.name} ({p.version})
                </option>
              ))}
            </Select>
          ) : (
            <Input value={packCode} onChange={(e) => setPackCode(e.target.value.toLowerCase())} maxLength={8} placeholder="ci" />
          )}
        </Field>
        <Field label={t("common.currency")}>
          <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} minLength={3} required className="font-mono uppercase" />
        </Field>
        <Field label={t("firm.companies.system")}>
          <Select value={system} onChange={(e) => setSystem(e.target.value as "NORMAL" | "SMT")}>
            <option value="NORMAL">{t("firm.companies.systemNormal")}</option>
            <option value="SMT">{t("firm.companies.systemSmt")}</option>
          </Select>
        </Field>
        <Field label={t("common.fiscalYear")}>
          <Input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} />
        </Field>
        <Field label={t("common.from")}>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </Field>
        <Field label={t("common.to")}>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? t("common.loading") : t("firm.companies.create")}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}
