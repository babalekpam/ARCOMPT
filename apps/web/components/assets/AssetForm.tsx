// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import type { Account } from "@/lib/types";
import { AccountPicker } from "@/components/entries/AccountPicker";
import { parseAmount } from "@/components/payroll/helpers";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { ACCOUNT_RE, DEFAULT_DEPRECIATION_MONTHS } from "./helpers";
import { ASSET_CATEGORIES, DEPRECIATION_METHODS, type AssetCategory, type CreateAssetInput, type DepreciationMethod, type FixedAsset, type Prorata } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Création d'une immobilisation : catégorie, comptes, coût, dates, méthode
 * d'amortissement, durée, prorata et écriture d'acquisition optionnelle.
 */
export function AssetForm() {
  const t = useT();
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [label, setLabel] = useState("");
  const [reference, setReference] = useState("");
  const [category, setCategory] = useState<AssetCategory>("CORPORELLE");
  const [accountNumber, setAccountNumber] = useState("");
  const [depreciationAccount, setDepreciationAccount] = useState("");
  const [expenseAccount, setExpenseAccount] = useState("");
  const [acquiredOn, setAcquiredOn] = useState(today);
  const [inServiceOn, setInServiceOn] = useState("");
  const [cost, setCost] = useState("");
  const [residualValue, setResidualValue] = useState("");
  const [method, setMethod] = useState<DepreciationMethod>("LINEAR");
  const [durationMonths, setDurationMonths] = useState(String(DEFAULT_DEPRECIATION_MONTHS.CORPORELLE));
  const [prorata, setProrata] = useState<Prorata>("DAYS");
  const [coefficient, setCoefficient] = useState("");
  const [priorDepreciation, setPriorDepreciation] = useState("");
  const [withAcquisition, setWithAcquisition] = useState(false);
  const [counterpart, setCounterpart] = useState("481");
  const [journalCode, setJournalCode] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [acqDate, setAcqDate] = useState("");
  const [acqReference, setAcqReference] = useState("");
  const [vatAmount, setVatAmount] = useState("");
  const [vatAccount, setVatAccount] = useState("");
  const [vatCode, setVatCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient<{ accounts: Account[] }>("/accounts")
      .then((d) => setAccounts(d.accounts.length > 0 ? d.accounts : null))
      .catch(() => setAccounts(null));
  }, []);

  const build = (): CreateAssetInput | string => {
    if (!label.trim()) return t("assets.form.errorLabel");
    if (!ACCOUNT_RE.test(accountNumber)) return t("assets.form.errorAccount");
    const c = parseAmount(cost);
    if (!c) return t("assets.form.errorCost");
    const out: CreateAssetInput = { label: label.trim(), category, accountNumber, acquiredOn, cost: c, method, prorata };
    if (reference.trim()) out.reference = reference.trim();
    if (inServiceOn) out.inServiceOn = inServiceOn;
    if (depreciationAccount) {
      if (!ACCOUNT_RE.test(depreciationAccount)) return t("assets.form.errorAccount");
      out.depreciationAccountNumber = depreciationAccount;
    }
    if (expenseAccount) {
      if (!ACCOUNT_RE.test(expenseAccount)) return t("assets.form.errorAccount");
      out.expenseAccountNumber = expenseAccount;
    }
    if (residualValue.trim()) {
      const v = parseAmount(residualValue, { allowZero: true });
      if (!v) return t("assets.form.errorAmount");
      out.residualValue = v;
    }
    if (priorDepreciation.trim()) {
      const v = parseAmount(priorDepreciation, { allowZero: true });
      if (!v) return t("assets.form.errorAmount");
      out.priorDepreciation = v;
    }
    if (method !== "NONE") {
      const n = Number(durationMonths);
      if (!Number.isInteger(n) || n <= 0) return t("assets.form.errorDuration");
      out.durationMonths = n;
      if (method === "DEGRESSIVE" && coefficient.trim()) {
        if (!/^\d+(\.\d+)?$/.test(coefficient.trim())) return t("assets.form.errorCoefficient");
        out.degressiveCoefficient = coefficient.trim();
      }
    }
    if (withAcquisition) {
      if (!ACCOUNT_RE.test(counterpart)) return t("assets.form.errorCounterpart");
      const acq: CreateAssetInput["acquisition"] = { counterpartAccount: counterpart };
      if (journalCode.trim()) acq.journalCode = journalCode.trim().toUpperCase();
      if (partnerId.trim()) {
        if (!UUID_RE.test(partnerId.trim())) return t("assets.form.errorPartner");
        acq.partnerId = partnerId.trim();
      }
      if (acqDate) acq.date = acqDate;
      if (acqReference.trim()) acq.reference = acqReference.trim();
      if (vatAmount.trim()) {
        const v = parseAmount(vatAmount);
        if (!v) return t("assets.form.errorAmount");
        acq.vat = { amount: v, ...(vatAccount ? { account: vatAccount } : {}), ...(vatCode.trim() ? { vatCode: vatCode.trim() } : {}) };
      }
      out.acquisition = acq;
    }
    return out;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const input = build();
    if (typeof input === "string") return setError(input);
    setBusy(true);
    try {
      const asset = await apiClient<FixedAsset>("/assets", { method: "POST", body: input });
      router.push(`/assets/${asset.id}?created=1`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onCategory = (c: AssetCategory) => {
    setCategory(c);
    const d = DEFAULT_DEPRECIATION_MONTHS[c] ?? 0;
    if (d === 0) setMethod("NONE");
    else setDurationMonths(String(d));
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">{t("assets.form.identity")}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("common.label")} className="sm:col-span-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} required />
          </Field>
          <Field label={`${t("common.reference")} (${t("common.optional")})`}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
          </Field>
          <Field label={t("assets.category")}>
            <Select value={category} onChange={(e) => onCategory(e.target.value as AssetCategory)}>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`assets.categories.${c}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("assets.form.account")} hint={t("assets.form.accountHint")}>
            <AccountPicker accounts={accounts} value={accountNumber} onChange={setAccountNumber} />
          </Field>
          <Field label={`${t("assets.form.depreciationAccount")} (${t("common.optional")})`} hint={t("assets.form.depreciationAccountHint")}>
            <AccountPicker accounts={accounts} value={depreciationAccount} onChange={setDepreciationAccount} />
          </Field>
          <Field label={`${t("assets.form.expenseAccount")} (${t("common.optional")})`} hint={t("assets.form.expenseAccountHint")}>
            <AccountPicker accounts={accounts} value={expenseAccount} onChange={setExpenseAccount} />
          </Field>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">{t("assets.form.valuation")}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("assets.cost")}>
            <Input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" className="text-right font-mono" required />
          </Field>
          <Field label={`${t("assets.form.residualValue")} (${t("common.optional")})`}>
            <Input value={residualValue} onChange={(e) => setResidualValue(e.target.value)} inputMode="decimal" className="text-right font-mono" />
          </Field>
          <Field label={`${t("assets.form.priorDepreciation")} (${t("common.optional")})`} hint={t("assets.form.priorDepreciationHint")}>
            <Input value={priorDepreciation} onChange={(e) => setPriorDepreciation(e.target.value)} inputMode="decimal" className="text-right font-mono" />
          </Field>
          <Field label={t("assets.acquiredOn")}>
            <Input type="date" value={acquiredOn} onChange={(e) => setAcquiredOn(e.target.value)} required />
          </Field>
          <Field label={`${t("assets.inServiceOn")} (${t("common.optional")})`} hint={t("assets.form.inServiceHint")}>
            <Input type="date" value={inServiceOn} onChange={(e) => setInServiceOn(e.target.value)} />
          </Field>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">{t("assets.form.depreciation")}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label={t("assets.method")}>
            <Select value={method} onChange={(e) => setMethod(e.target.value as DepreciationMethod)}>
              {DEPRECIATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`assets.methods.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          {method !== "NONE" ? (
            <>
              <Field label={t("assets.durationMonths")}>
                <Input type="number" min={1} value={durationMonths} onChange={(e) => setDurationMonths(e.target.value)} required />
              </Field>
              <Field label={t("assets.prorata")}>
                <Select value={prorata} onChange={(e) => setProrata(e.target.value as Prorata)}>
                  <option value="DAYS">{t("assets.prorataKind.DAYS")}</option>
                  <option value="MONTHS">{t("assets.prorataKind.MONTHS")}</option>
                </Select>
              </Field>
            </>
          ) : null}
          {method === "DEGRESSIVE" ? (
            <Field label={`${t("assets.form.coefficient")} (${t("common.optional")})`} hint={t("assets.form.coefficientHint")}>
              <Input value={coefficient} onChange={(e) => setCoefficient(e.target.value)} inputMode="decimal" className="font-mono" placeholder="2" />
            </Field>
          ) : null}
        </div>
      </section>

      <section>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={withAcquisition} onChange={(e) => setWithAcquisition(e.target.checked)} />
          {t("assets.form.postAcquisition")}
        </label>
        <p className="mt-1 text-xs text-slate-500">{t("assets.form.postAcquisitionHint")}</p>
        {withAcquisition ? (
          <div className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-3 dark:border-slate-800">
            <Field label={t("assets.form.counterpart")} hint={t("assets.form.counterpartHint")}>
              <AccountPicker accounts={accounts} value={counterpart} onChange={setCounterpart} />
            </Field>
            <Field label={`${t("common.journal")} (${t("common.optional")})`}>
              <Input value={journalCode} onChange={(e) => setJournalCode(e.target.value)} maxLength={8} className="font-mono uppercase" placeholder="AC" />
            </Field>
            <Field label={`${t("assets.form.partner")} (${t("common.optional")})`} hint={t("assets.form.partnerHint")}>
              <Input value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field label={`${t("common.date")} (${t("common.optional")})`}>
              <Input type="date" value={acqDate} onChange={(e) => setAcqDate(e.target.value)} />
            </Field>
            <Field label={`${t("common.reference")} (${t("common.optional")})`}>
              <Input value={acqReference} onChange={(e) => setAcqReference(e.target.value)} maxLength={60} />
            </Field>
            <Field label={`${t("assets.form.vatAmount")} (${t("common.optional")})`}>
              <Input value={vatAmount} onChange={(e) => setVatAmount(e.target.value)} inputMode="decimal" className="text-right font-mono" />
            </Field>
            {vatAmount.trim() ? (
              <>
                <Field label={`${t("assets.form.vatAccount")} (${t("common.optional")})`}>
                  <AccountPicker accounts={accounts} value={vatAccount} onChange={setVatAccount} />
                </Field>
                <Field label={`${t("assets.form.vatCode")} (${t("common.optional")})`}>
                  <Input value={vatCode} onChange={(e) => setVatCode(e.target.value)} className="font-mono" />
                </Field>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" disabled={busy}>
        {busy ? t("common.loading") : t("assets.form.create")}
      </Button>
    </form>
  );
}
