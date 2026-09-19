"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { parseAmount, TREASURY_ACCOUNTS } from "@/components/payroll/helpers";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { ACCOUNT_RE } from "./helpers";
import type { DisposalResult, FixedAsset } from "./types";

type Dialog = "dispose" | "delete" | null;

/** Cession (date, prix, compte de trésorerie) et suppression d'une fiche non encore dotée. */
export function AssetActions({ asset, canDelete, currency }: { asset: FixedAsset; canDelete: boolean; currency: string }) {
  const t = useT();
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DisposalResult | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [price, setPrice] = useState("");
  const [treasury, setTreasury] = useState<string>(TREASURY_ACCOUNTS[0]);
  const [customTreasury, setCustomTreasury] = useState("");
  const [label, setLabel] = useState("");

  const dispose = async () => {
    const p = parseAmount(price, { allowZero: true });
    if (!p) return setError(t("assets.dispose.errorPrice"));
    const account = treasury === "custom" ? customTreasury.trim() : treasury;
    if (!ACCOUNT_RE.test(account)) return setError(t("payroll.run.errorTreasury"));
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient<DisposalResult>(`/assets/${asset.id}/dispose`, { method: "POST", body: { date, price: p, treasuryAccount: account, ...(label.trim() ? { label: label.trim() } : {}) } });
      setResult(r);
      setDialog(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient<void>(`/assets/${asset.id}`, { method: "DELETE" });
      router.push("/assets");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (asset.disposedOn && !result) return null;

  return (
    <div className="space-y-3">
      {!asset.disposedOn ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDialog("dispose")} disabled={busy}>
            {t("assets.dispose.action")}
          </Button>
          {canDelete ? (
            <Button variant="danger" size="sm" onClick={() => setDialog("delete")} disabled={busy}>
              {t("assets.delete.action")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error && dialog === null ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <Alert tone="success">
          <p className="font-medium">{t("assets.dispose.done")}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            <li>
              {t("assets.netBookValue")} : <Money value={result.netBookValue} currency={currency} /> · {t("assets.cumulative")} : <Money value={result.cumulativeDepreciation} currency={currency} />
            </li>
            <li>
              {t("assets.dispose.gainLoss")} : <Money value={result.gainLoss} currency={currency} colorSign />
            </li>
            <li className="font-mono">
              {t("assets.dispose.disposalEntry")} {result.disposalEntryId}
              {result.proceedsEntryId ? ` · ${t("assets.dispose.proceedsEntry")} ${result.proceedsEntryId}` : ""}
              {result.depreciationEntryId ? ` · ${t("assets.dispose.depreciationEntry")} ${result.depreciationEntryId}` : ""}
            </li>
          </ul>
        </Alert>
      ) : null}

      <ConfirmDialog open={dialog === "dispose"} title={t("assets.dispose.title")} busy={busy} onConfirm={() => void dispose()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("assets.dispose.confirm", { label: asset.label })}</p>
        <div className="mt-3 space-y-2">
          <label className="block text-xs">
            {t("assets.dispose.date")}
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" required />
          </label>
          <label className="block text-xs">
            {t("assets.dispose.price")}
            <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className="mt-1 text-right font-mono" placeholder="0" />
          </label>
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
            {t("common.label")} ({t("common.optional")})
            <Input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1" maxLength={200} />
          </label>
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "delete"} title={t("assets.delete.action")} confirmVariant="danger" busy={busy} onConfirm={() => void remove()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("assets.delete.confirm", { label: asset.label })}</p>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </ConfirmDialog>
    </div>
  );
}
