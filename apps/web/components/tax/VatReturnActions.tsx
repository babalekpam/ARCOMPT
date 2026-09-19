"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { TREASURY_ACCOUNTS } from "@/components/payroll/helpers";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Select } from "@/components/ui/Field";
import type { TaxReturn } from "./types";

type Dialog = "validate" | "pay" | "file" | null;

/** Valider (écriture de liquidation), payer et marquer déposée une déclaration de TVA. */
export function VatReturnActions({ taxReturn }: { taxReturn: TaxReturn }) {
  const t = useT();
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [validateDate, setValidateDate] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [treasury, setTreasury] = useState<string>(TREASURY_ACCOUNTS[0]);
  const [customTreasury, setCustomTreasury] = useState("");
  const [reference, setReference] = useState("");

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

  const validate = () =>
    call(async () => {
      const r = await apiClient<TaxReturn>(`/tax/vat/returns/${taxReturn.id}/validate`, { method: "POST", body: validateDate ? { date: validateDate } : {} });
      return t("tax.vat.validated", { entryId: r.entryId ?? "?" });
    });
  const pay = () =>
    call(async () => {
      const account = treasury === "custom" ? customTreasury.trim() : treasury;
      if (!/^5\d{1,12}$/.test(account)) throw new Error(t("payroll.run.errorTreasury"));
      const r = await apiClient<TaxReturn>(`/tax/vat/returns/${taxReturn.id}/pay`, { method: "POST", body: { date: payDate, treasuryAccount: account } });
      return t("tax.vat.paid", { entryId: r.paymentEntryId ?? "?" });
    });
  const file = () =>
    call(async () => {
      if (!reference.trim()) throw new Error(t("tax.vat.errorReference"));
      await apiClient<TaxReturn>(`/tax/vat/returns/${taxReturn.id}/file`, { method: "POST", body: { filingReference: reference.trim() } });
      return t("tax.vat.filed");
    });

  const s = taxReturn.status;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {s === "COMPUTED" ? <Button onClick={() => setDialog("validate")} disabled={busy}>{t("tax.vat.validate")}</Button> : null}
        {(s === "VALIDATED" || s === "FILED") && !taxReturn.paymentEntryId ? (
          <Button onClick={() => setDialog("pay")} disabled={busy}>
            {t("tax.vat.pay")}
          </Button>
        ) : null}
        {(s === "COMPUTED" || s === "VALIDATED") && !taxReturn.filedAt ? (
          <Button variant="secondary" onClick={() => setDialog("file")} disabled={busy}>
            {t("tax.vat.markFiled")}
          </Button>
        ) : null}
        {s === "DRAFT" ? <span className="text-sm text-slate-500">{t("tax.vat.draftHint")}</span> : null}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      <ConfirmDialog open={dialog === "validate"} title={t("tax.vat.validate")} busy={busy} onConfirm={() => void validate()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("tax.vat.validateConfirm")}</p>
        <label className="mt-3 block text-xs">
          {t("payroll.run.entryDate")} ({t("common.optional")})
          <Input type="date" value={validateDate} onChange={(e) => setValidateDate(e.target.value)} className="mt-1" />
        </label>
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "pay"} title={t("tax.vat.pay")} busy={busy} onConfirm={() => void pay()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("tax.vat.payConfirm")}</p>
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

      <ConfirmDialog open={dialog === "file"} title={t("tax.vat.markFiled")} busy={busy} onConfirm={() => void file()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("tax.vat.markFiledConfirm")}</p>
        <label className="mt-3 block text-xs">
          {t("tax.vat.filingReference")}
          <Input value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1" maxLength={120} />
        </label>
      </ConfirmDialog>
    </div>
  );
}
