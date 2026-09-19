"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { FILING_FORMATS, FILING_KINDS, type Filing, type FilingFormat, type FilingKind } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Préparer un dépôt (DSF, TVA, social) pour le dossier courant : POST /portal/filings/prepare. */
export function PrepareFilingForm({ fiscalYears }: { fiscalYears: Array<{ id: string; code: string }> }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fiscalYearId, setFiscalYearId] = useState(fiscalYears[0]?.id ?? "");
  const [kind, setKind] = useState<FilingKind>("VAT");
  const [portalName, setPortalName] = useState("");
  const [format, setFormat] = useState<FilingFormat>("XLSX");
  const [periodLabel, setPeriodLabel] = useState("");
  const [fileDocumentId, setFileDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!UUID_RE.test(fiscalYearId.trim()) || (fileDocumentId && !UUID_RE.test(fileDocumentId.trim()))) return setError(t("firm.requests.invalidId"));
    setBusy(true);
    setError(null);
    try {
      await apiClient<Filing>("/portal/filings/prepare", {
        method: "POST",
        body: {
          fiscalYearId: fiscalYearId.trim(),
          kind,
          format,
          ...(portalName.trim() ? { portalName: portalName.trim() } : {}),
          ...(periodLabel.trim() ? { periodLabel: periodLabel.trim() } : {}),
          ...(fileDocumentId.trim() ? { fileDocumentId: fileDocumentId.trim() } : {}),
        },
      });
      setOpen(false);
      setPeriodLabel("");
      setFileDocumentId("");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>{t("firm.filings.prepare")}</Button>;
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-xl border border-slate-300 p-3 dark:border-slate-700">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("common.fiscalYear")} hint={fiscalYears.length === 0 ? t("firm.filings.fiscalYearHint") : undefined}>
          {fiscalYears.length > 0 ? (
            <Select value={fiscalYearId} onChange={(e) => setFiscalYearId(e.target.value)}>
              {fiscalYears.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.code}
                </option>
              ))}
            </Select>
          ) : (
            <Input value={fiscalYearId} onChange={(e) => setFiscalYearId(e.target.value)} className="font-mono text-xs" placeholder="uuid" required />
          )}
        </Field>
        <Field label={t("firm.filings.kind")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as FilingKind)}>
            {FILING_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`firm.filings.kind.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t("firm.filings.portal")} (${t("common.optional")})`}>
          <Input value={portalName} onChange={(e) => setPortalName(e.target.value)} maxLength={200} />
        </Field>
        <Field label={t("firm.filings.format")}>
          <Select value={format} onChange={(e) => setFormat(e.target.value as FilingFormat)}>
            {FILING_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t("firm.filings.period")} (${t("common.optional")})`}>
          <Input value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} maxLength={20} placeholder="2025-09" />
        </Field>
        <Field label={`${t("firm.filings.fileDocument")} (${t("common.optional")})`}>
          <Input value={fileDocumentId} onChange={(e) => setFileDocumentId(e.target.value)} className="font-mono text-xs" placeholder="uuid" />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? t("common.loading") : t("firm.filings.prepare")}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

/** Actions d'un dépôt : marquer déposé (avec accusé facultatif) ou joindre un accusé. */
export function FilingActions({ filing }: { filing: Filing }) {
  const t = useT();
  const router = useRouter();
  const [receipt, setReceipt] = useState("");
  const [busy, setBusy] = useState<"filed" | "receipt" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const receiptValid = UUID_RE.test(receipt.trim());

  const run = async (action: "filed" | "receipt") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "filed") await apiClient<Filing>(`/portal/filings/${filing.id}/mark-filed`, { method: "POST", body: receiptValid ? { receiptDocumentId: receipt.trim() } : {} });
      else await apiClient<Filing>(`/portal/filings/${filing.id}/attach-receipt`, { method: "POST", body: { receiptDocumentId: receipt.trim() } });
      setReceipt("");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder={t("firm.filings.receiptId")} aria-label={t("firm.filings.receiptId")} className="w-56 font-mono text-xs" />
      {filing.status === "PREPARED" ? (
        <Button size="sm" onClick={() => void run("filed")} disabled={busy !== null}>
          {busy === "filed" ? t("common.loading") : t("firm.filings.markFiled")}
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" onClick={() => void run("receipt")} disabled={busy !== null || !receiptValid}>
        {busy === "receipt" ? t("common.loading") : t("firm.filings.attachReceipt")}
      </Button>
      {error ? <span className="basis-full text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
