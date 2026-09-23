// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { isMasked, parseAmount } from "./helpers";
import { CONTRACT_TYPES, type Allowance, type ContractType, type Employee, type EmployeeInput } from "./types";

interface AllowanceRow extends Allowance {
  key: number;
}

/**
 * Création / modification d'un salarié. Les champs sensibles arrivent masqués
 * pour certains rôles : le formulaire passe alors en lecture seule (l'API
 * refuserait de toute façon l'écriture).
 */
export function EmployeeForm({ employee }: { employee?: Employee }) {
  const t = useT();
  const router = useRouter();
  const readOnly = employee ? isMasked(employee.baseSalary) : false;
  const [matricule, setMatricule] = useState(employee?.matricule ?? "");
  const [firstName, setFirstName] = useState(employee?.firstName ?? "");
  const [lastName, setLastName] = useState(employee?.lastName ?? "");
  const [hireDate, setHireDate] = useState(employee?.hireDate ?? new Date().toISOString().slice(0, 10));
  const [leaveDate, setLeaveDate] = useState(employee?.leaveDate ?? "");
  const [contractType, setContractType] = useState<ContractType>(employee?.contractType ?? "CDI");
  const [category, setCategory] = useState(employee?.category ?? "");
  const [baseSalary, setBaseSalary] = useState(employee && !readOnly ? employee.baseSalary : "");
  const [dependants, setDependants] = useState(String(employee?.dependants ?? 0));
  const [ssn, setSsn] = useState(employee?.socialSecurityNumber ?? "");
  const [taxId, setTaxId] = useState(employee?.taxId ?? "");
  const [bank, setBank] = useState(employee?.bankDetails?.bank ?? "");
  const [iban, setIban] = useState(employee?.bankDetails?.iban ?? "");
  const [rib, setRib] = useState(employee?.bankDetails?.rib ?? "");
  const [mobileMoney, setMobileMoney] = useState(employee?.bankDetails?.mobileMoney ?? "");
  const [allowances, setAllowances] = useState<AllowanceRow[]>((employee?.allowances ?? []).map((a, i) => ({ ...a, key: i })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateAllowance = (key: number, patch: Partial<Allowance>) => setAllowances((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const build = (): EmployeeInput | string => {
    const salary = parseAmount(baseSalary, { allowZero: true });
    if (!matricule.trim() || !firstName.trim() || !lastName.trim()) return t("payroll.employee.errorIdentity");
    if (!salary) return t("payroll.employee.errorSalary");
    const out: EmployeeInput = { matricule: matricule.trim(), firstName: firstName.trim(), lastName: lastName.trim(), hireDate, contractType, baseSalary: salary, dependants: Number(dependants) || 0 };
    if (leaveDate) out.leaveDate = leaveDate;
    if (category.trim()) out.category = category.trim();
    if (ssn.trim()) out.socialSecurityNumber = ssn.trim();
    if (taxId.trim()) out.taxId = taxId.trim();
    const bd = { ...(bank.trim() ? { bank: bank.trim() } : {}), ...(iban.trim() ? { iban: iban.trim() } : {}), ...(rib.trim() ? { rib: rib.trim() } : {}), ...(mobileMoney.trim() ? { mobileMoney: mobileMoney.trim() } : {}) };
    if (Object.keys(bd).length > 0) out.bankDetails = bd;
    const list: Allowance[] = [];
    for (const a of allowances) {
      const amount = parseAmount(a.amount, { allowZero: true });
      if (!a.code.trim() || !a.label.trim() || !amount) return t("payroll.employee.errorAllowance");
      list.push({ code: a.code.trim(), label: a.label.trim(), amount, taxable: a.taxable !== false });
    }
    out.allowances = list;
    return out;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const input = build();
    if (typeof input === "string") return setError(input);
    setBusy(true);
    try {
      const saved = employee ? await apiClient<Employee>(`/payroll/employees/${employee.id}`, { method: "PATCH", body: input }) : await apiClient<Employee>("/payroll/employees", { method: "POST", body: input });
      router.push(`/payroll/employees/${saved.id}?saved=1`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-6">
      {readOnly ? <Alert tone="info">{t("payroll.employee.maskedNotice")}</Alert> : null}
      <fieldset disabled={readOnly || busy} className="space-y-6">
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("payroll.employee.identity")}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("payroll.employee.matricule")}>
              <Input value={matricule} onChange={(e) => setMatricule(e.target.value)} maxLength={30} required />
            </Field>
            <Field label={t("payroll.employee.lastName")}>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={120} required />
            </Field>
            <Field label={t("payroll.employee.firstName")}>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={120} required />
            </Field>
            <Field label={t("payroll.employee.ssn")}>
              <Input value={ssn} onChange={(e) => setSsn(e.target.value)} maxLength={40} className="font-mono" />
            </Field>
            <Field label={t("payroll.employee.taxId")}>
              <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={40} className="font-mono" />
            </Field>
            <Field label={t("payroll.employee.dependants")}>
              <Input type="number" min={0} max={30} value={dependants} onChange={(e) => setDependants(e.target.value)} />
            </Field>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("payroll.employee.contract")}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("payroll.employee.contractType")}>
              <Select value={contractType} onChange={(e) => setContractType(e.target.value as ContractType)}>
                {CONTRACT_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {t(`payroll.contractType.${c}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("payroll.employee.category")} hint={t("payroll.employee.categoryHint")}>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} />
            </Field>
            <Field label={t("payroll.employee.baseSalary")} hint={t("payroll.employee.baseSalaryHint")}>
              <Input value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} inputMode="decimal" className="text-right font-mono" placeholder={readOnly ? "***" : "0"} required={!readOnly} />
            </Field>
            <Field label={t("payroll.employee.hireDate")}>
              <Input type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} required />
            </Field>
            <Field label={`${t("payroll.employee.leaveDate")} (${t("common.optional")})`}>
              <Input type="date" value={leaveDate} onChange={(e) => setLeaveDate(e.target.value)} />
            </Field>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("payroll.employee.allowances")}</h3>
            <Button variant="secondary" size="sm" onClick={() => setAllowances((rows) => [...rows, { key: Date.now(), code: "", label: "", amount: "", taxable: true }])}>
              + {t("payroll.employee.addAllowance")}
            </Button>
          </div>
          {allowances.length === 0 ? <p className="text-xs text-slate-500">{t("payroll.employee.noAllowance")}</p> : null}
          <div className="space-y-2">
            {allowances.map((a) => (
              <div key={a.key} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-[8rem_1fr_8rem_auto_auto] sm:border-0 sm:p-0 dark:border-slate-800">
                <Input value={a.code} onChange={(e) => updateAllowance(a.key, { code: e.target.value })} placeholder={t("payroll.employee.allowanceCode")} maxLength={40} className="font-mono" />
                <Input value={a.label} onChange={(e) => updateAllowance(a.key, { label: e.target.value })} placeholder={t("common.label")} maxLength={120} />
                <Input value={a.amount} onChange={(e) => updateAllowance(a.key, { amount: e.target.value })} placeholder={t("common.amount")} inputMode="decimal" className="text-right font-mono" />
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={a.taxable !== false} onChange={(e) => updateAllowance(a.key, { taxable: e.target.checked })} />
                  {t("payroll.employee.taxable")}
                </label>
                <Button variant="ghost" size="sm" onClick={() => setAllowances((rows) => rows.filter((r) => r.key !== a.key))} aria-label={t("payroll.employee.removeAllowance")}>
                  ✕
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("payroll.employee.bank")}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("payroll.employee.bankName")}>
              <Input value={bank} onChange={(e) => setBank(e.target.value)} maxLength={120} />
            </Field>
            <Field label="IBAN">
              <Input value={iban} onChange={(e) => setIban(e.target.value)} maxLength={40} className="font-mono" />
            </Field>
            <Field label="RIB">
              <Input value={rib} onChange={(e) => setRib(e.target.value)} maxLength={40} className="font-mono" />
            </Field>
            <Field label={t("payroll.employee.mobileMoney")}>
              <Input value={mobileMoney} onChange={(e) => setMobileMoney(e.target.value)} maxLength={30} className="font-mono" />
            </Field>
          </div>
        </section>
      </fieldset>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!readOnly ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.loading") : employee ? t("common.save") : t("payroll.employee.create")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
