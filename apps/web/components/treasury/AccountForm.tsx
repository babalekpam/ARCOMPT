"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { TREASURY_KINDS, type TreasuryAccount, type TreasuryAccountInput, type TreasuryAccountKind } from "./types";

const DEFAULT_NUMBER: Record<TreasuryAccountKind, string> = { BANK: "521", CASH: "571", MOBILE_MONEY: "5381" };

/** Création (POST /v1/treasury/accounts) ou modification (PATCH) d'un compte de trésorerie. */
export function AccountForm({ existing, currency, onSaved }: { existing?: TreasuryAccount; currency: string; onSaved?: (a: TreasuryAccount) => void }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TreasuryAccountKind>(existing?.kind ?? "BANK");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [accountNumber, setAccountNumber] = useState(existing?.accountNumber ?? DEFAULT_NUMBER.BANK);
  const [cur, setCur] = useState(existing?.currency ?? currency);
  const [bankName, setBankName] = useState(existing?.bankName ?? "");
  const [iban, setIban] = useState(existing?.iban ?? "");
  const [mmOperator, setMmOperator] = useState(existing?.mmOperator ?? "");
  const [mmPhone, setMmPhone] = useState(existing?.mmPhone ?? "");
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (!/^5\d{1,12}$/.test(accountNumber.trim())) return setError(t("treasury.account.errorNumber"));
    const body: TreasuryAccountInput = {
      kind,
      label: label.trim(),
      accountNumber: accountNumber.trim(),
      currency: cur.trim().toUpperCase(),
      ...(kind === "BANK" && bankName.trim() ? { bankName: bankName.trim() } : {}),
      ...(kind === "BANK" && iban.trim() ? { iban: iban.trim() } : {}),
      ...(kind === "MOBILE_MONEY" && mmOperator.trim() ? { mmOperator: mmOperator.trim() } : {}),
      ...(kind === "MOBILE_MONEY" && mmPhone.trim() ? { mmPhone: mmPhone.trim() } : {}),
      active,
    };
    setBusy(true);
    try {
      const a = existing ? await apiClient<TreasuryAccount>(`/treasury/accounts/${existing.id}`, { method: "PATCH", body }) : await apiClient<TreasuryAccount>("/treasury/accounts", { method: "POST", body });
      setSaved(true);
      onSaved?.(a);
      if (!existing) {
        setOpen(false);
        setLabel("");
        router.push(`/treasury/${a.id}`);
      }
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!existing && !open) {
    return (
      <Button onClick={() => setOpen(true)}>
        + {t("treasury.account.new")}
      </Button>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("treasury.account.kind")}>
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as TreasuryAccountKind;
              setKind(k);
              if (!existing) setAccountNumber(DEFAULT_NUMBER[k]);
            }}
            disabled={Boolean(existing)}
          >
            {TREASURY_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`treasury.kind.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("common.label")} className="sm:col-span-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} required />
        </Field>
        <Field label={t("treasury.account.number")} hint={t("treasury.account.numberHint")}>
          <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} inputMode="numeric" className="font-mono" required />
        </Field>
        <Field label={t("common.currency")}>
          <Input value={cur} onChange={(e) => setCur(e.target.value)} maxLength={3} className="font-mono uppercase" required />
        </Field>
        {kind === "BANK" ? (
          <>
            <Field label={t("treasury.account.bankName")}>
              <Input value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={120} />
            </Field>
            <Field label={t("treasury.account.iban")} className="sm:col-span-2">
              <Input value={iban} onChange={(e) => setIban(e.target.value)} maxLength={64} className="font-mono" />
            </Field>
          </>
        ) : null}
        {kind === "MOBILE_MONEY" ? (
          <>
            <Field label={t("treasury.account.mmOperator")}>
              <Input value={mmOperator} onChange={(e) => setMmOperator(e.target.value)} maxLength={60} placeholder="Orange Money, MTN MoMo, Wave…" />
            </Field>
            <Field label={t("treasury.account.mmPhone")}>
              <Input value={mmPhone} onChange={(e) => setMmPhone(e.target.value)} maxLength={30} inputMode="tel" />
            </Field>
          </>
        ) : null}
        {existing ? (
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t("treasury.account.active")}
          </label>
        ) : null}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {saved ? <Alert tone="success">{t("treasury.account.saved")}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t("common.loading") : t("common.save")}
        </Button>
        {!existing ? (
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
