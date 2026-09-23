// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Select } from "@/components/ui/Field";
import { buildComputeInputs, rowFromInputs, TREASURY_ACCOUNTS, type VariableRow } from "./helpers";
import type { Payslip, PayrollRun } from "./types";

export interface RunEmployee {
  id: string;
  matricule: string;
  name: string;
}

type Dialog = "validate" | "pay" | null;

/**
 * Actions d'un cycle de paie : calcul (avec variables du mois par salarié),
 * validation (écriture de paie) et paiement (écriture de trésorerie).
 */
export function RunActions({ run, employees, payslips }: { run: PayrollRun; employees: RunEmployee[]; payslips: Payslip[] }) {
  const t = useT();
  const router = useRouter();
  const byEmployee = new Map(payslips.map((p) => [p.employeeId, p]));
  const [rows, setRows] = useState<VariableRow[]>(() => employees.map((e) => rowFromInputs(e.id, byEmployee.get(e.id)?.inputs)));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [validateDate, setValidateDate] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [treasury, setTreasury] = useState<string>(TREASURY_ACCOUNTS[0]);
  const [customTreasury, setCustomTreasury] = useState("");

  const update = (employeeId: string, patch: Partial<VariableRow>) => setRows((rs) => rs.map((r) => (r.employeeId === employeeId ? { ...r, ...patch } : r)));

  const call = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      setSuccess(await fn());
      setDialog(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const compute = () =>
    call(async () => {
      const { inputs, invalid } = buildComputeInputs(rows, { bonus: t("payroll.run.bonus"), absences: t("payroll.run.absences") });
      if (invalid.length > 0) throw new Error(t("payroll.run.errorInputs"));
      const res = await apiClient<{ run: PayrollRun; payslips: Payslip[] }>(`/payroll/runs/${run.id}/compute`, { method: "POST", body: { inputs } });
      return t("payroll.run.computed", { count: res.payslips.length });
    });

  const validate = () =>
    call(async () => {
      const res = await apiClient<{ run: PayrollRun; entryId: string }>(`/payroll/runs/${run.id}/validate`, { method: "POST", body: validateDate ? { date: validateDate } : {} });
      return t("payroll.run.validated", { entryId: res.entryId });
    });

  const pay = () =>
    call(async () => {
      const account = treasury === "custom" ? customTreasury.trim() : treasury;
      if (!/^5\d{1,12}$/.test(account)) throw new Error(t("payroll.run.errorTreasury"));
      const res = await apiClient<{ run: PayrollRun; entryId: string }>(`/payroll/runs/${run.id}/pay`, { method: "POST", body: { treasuryAccountNumber: account, date: payDate } });
      return t("payroll.run.paid", { entryId: res.entryId });
    });

  const canCompute = run.status === "DRAFT" || run.status === "COMPUTED";

  return (
    <div className="space-y-4">
      {canCompute ? (
        <div>
          <p className="mb-2 text-xs text-slate-500">{t("payroll.run.variablesHint")}</p>
          {employees.length === 0 ? <Alert tone="warning">{t("payroll.run.noEmployees")}</Alert> : null}
          {employees.length > 0 ? (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("payroll.employee.one")}</th>
                    <th className="py-2 pr-3 text-right">{t("payroll.run.overtime")}</th>
                    <th className="py-2 pr-3">{t("payroll.run.bonusLabel")}</th>
                    <th className="py-2 pr-3 text-right">{t("payroll.run.bonus")}</th>
                    <th className="py-2 pr-3 text-right">{t("payroll.run.absences")}</th>
                    <th className="py-2 text-right">{t("payroll.run.advance")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => {
                    const e = employees.find((x) => x.id === r.employeeId);
                    return (
                      <tr key={r.employeeId}>
                        <td className="py-1.5 pr-3">
                          <div className="font-medium">{e?.name}</div>
                          <div className="font-mono text-[11px] text-slate-500">{e?.matricule}</div>
                        </td>
                        <td className="py-1.5 pr-3"><Input value={r.overtime} onChange={(ev) => update(r.employeeId, { overtime: ev.target.value })} inputMode="decimal" className="w-28 text-right font-mono" /></td>
                        <td className="py-1.5 pr-3"><Input value={r.bonusLabel} onChange={(ev) => update(r.employeeId, { bonusLabel: ev.target.value })} placeholder={t("payroll.run.bonus")} className="w-36" maxLength={120} /></td>
                        <td className="py-1.5 pr-3"><Input value={r.bonus} onChange={(ev) => update(r.employeeId, { bonus: ev.target.value })} inputMode="decimal" className="w-28 text-right font-mono" /></td>
                        <td className="py-1.5 pr-3"><Input value={r.absences} onChange={(ev) => update(r.employeeId, { absences: ev.target.value })} inputMode="decimal" className="w-28 text-right font-mono" /></td>
                        <td className="py-1.5"><Input value={r.advance} onChange={(ev) => update(r.employeeId, { advance: ev.target.value })} inputMode="decimal" className="w-28 text-right font-mono" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canCompute ? (
          <Button onClick={() => void compute()} disabled={busy || employees.length === 0}>
            {busy ? t("common.loading") : run.status === "COMPUTED" ? t("payroll.run.recompute") : t("payroll.run.compute")}
          </Button>
        ) : null}
        {run.status === "COMPUTED" ? (
          <Button variant="secondary" onClick={() => setDialog("validate")} disabled={busy}>
            {t("payroll.run.validate")}
          </Button>
        ) : null}
        {run.status === "VALIDATED" ? (
          <Button onClick={() => setDialog("pay")} disabled={busy}>
            {t("payroll.run.pay")}
          </Button>
        ) : null}
        {run.status === "PAID" ? <span className="text-sm text-emerald-700 dark:text-emerald-300">{t("payroll.run.paidNotice")}</span> : null}
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      <ConfirmDialog open={dialog === "validate"} title={t("payroll.run.validate")} busy={busy} onConfirm={() => void validate()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("payroll.run.validateConfirm")}</p>
        <label className="mt-3 block text-xs">
          {t("payroll.run.entryDate")} ({t("common.optional")})
          <Input type="date" value={validateDate} onChange={(e) => setValidateDate(e.target.value)} className="mt-1" />
        </label>
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "pay"} title={t("payroll.run.pay")} busy={busy} onConfirm={() => void pay()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("payroll.run.payConfirm")}</p>
        <div className="mt-3 space-y-2">
          <label className="block text-xs">
            {t("payroll.run.treasuryAccount")}
            <Select value={treasury} onChange={(e) => setTreasury(e.target.value)} className="mt-1">
              {TREASURY_ACCOUNTS.map((a) => (
                <option key={a} value={a}>
                  {a} — {t(`payroll.treasury.${a}`)}
                </option>
              ))}
              <option value="custom">{t("payroll.run.otherAccount")}</option>
            </Select>
          </label>
          {treasury === "custom" ? <Input value={customTreasury} onChange={(e) => setCustomTreasury(e.target.value)} placeholder="52xx" inputMode="numeric" className="font-mono" /> : null}
          <label className="block text-xs">
            {t("payroll.run.payDate")}
            <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className="mt-1" required />
          </label>
        </div>
      </ConfirmDialog>
    </div>
  );
}
