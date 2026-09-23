"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { errorMessage, NetworkError, proxyUrl } from "@/lib/api-client";
import { parseApiResponse } from "@/lib/api-shared";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { buildImportRequest, detectImportKind, type ImportKind } from "./import-text";
import type { StatementImportResult } from "./types";

/**
 * Import d'un relevé : fichier (CSV ou export SMS) lu côté navigateur, ou texte
 * collé ; envoi en `text/csv` (options de période en requête) ou en JSON (SMS,
 * options de parseur). Le résumé d'import est affiché (lignes, doublons, erreurs).
 */
export function StatementImportForm({ accountId, accountKind, onImported }: { accountId: string; accountKind: string; onImported?: (r: StatementImportResult) => void }) {
  const t = useT();
  const router = useRouter();
  const [kind, setKind] = useState<ImportKind>(accountKind === "MOBILE_MONEY" ? "SMS" : "CSV");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [openingBalance, setOpeningBalance] = useState("");
  const [closingBalance, setClosingBalance] = useState("");
  const [dateFormat, setDateFormat] = useState<"" | "DMY" | "YMD" | "MDY">("");
  const [separator, setSeparator] = useState("");
  const [decimalSeparator, setDecimalSeparator] = useState<"" | "," | ".">("");
  const [hasHeader, setHasHeader] = useState(true);
  const [bankPerspective, setBankPerspective] = useState(false);
  const [defaultDate, setDefaultDate] = useState("");
  const [includeFees, setIncludeFees] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StatementImportResult | null>(null);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      setText(content);
      setKind(file.name.toLowerCase().endsWith(".csv") ? "CSV" : detectImportKind(content));
    };
    reader.readAsText(file);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!text.trim()) return setError(t("treasury.import.errorEmpty"));
    const req = buildImportRequest(accountId, {
      kind,
      text,
      periodFrom,
      periodTo,
      openingBalance,
      closingBalance,
      ...(dateFormat ? { dateFormat } : {}),
      ...(separator ? { separator } : {}),
      ...(decimalSeparator ? { decimalSeparator } : {}),
      hasHeader,
      bankPerspective,
      defaultDate,
      includeFees,
    });
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(proxyUrl(req.path, req.query), { method: "POST", headers: { accept: "application/json", "content-type": req.contentType }, body: req.body });
      } catch (err) {
        throw new NetworkError(err instanceof Error ? err.message : "réseau indisponible");
      }
      const r = await parseApiResponse<StatementImportResult>(res);
      setResult(r);
      setText("");
      setFileName(null);
      onImported?.(r);
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
        <Field label={t("treasury.import.file")} className="sm:col-span-2">
          <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm dark:file:border-slate-700 dark:file:bg-slate-900" />
          {fileName ? <span className="mt-1 block text-xs text-slate-500">{fileName}</span> : null}
        </Field>
        <Field label={t("treasury.import.kind")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
            <option value="CSV">{t("treasury.import.kindCsv")}</option>
            <option value="SMS">{t("treasury.import.kindSms")}</option>
          </Select>
        </Field>
      </div>
      <Field label={t("treasury.import.text")} hint={kind === "CSV" ? t("treasury.import.csvHint") : t("treasury.import.smsHint")}>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!fileName && e.target.value.length > 20) setKind(detectImportKind(e.target.value));
          }}
          rows={6}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs shadow-sm dark:border-slate-700 dark:bg-slate-950"
          placeholder={kind === "CSV" ? t("treasury.import.csvPlaceholder") : t("treasury.import.smsPlaceholder")}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t("common.from")}>
          <Input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
        </Field>
        <Field label={t("common.to")}>
          <Input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
        </Field>
        <Field label={t("treasury.import.openingBalance")}>
          <Input value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} inputMode="decimal" className="text-right font-mono" />
        </Field>
        <Field label={t("treasury.import.closingBalance")}>
          <Input value={closingBalance} onChange={(e) => setClosingBalance(e.target.value)} inputMode="decimal" className="text-right font-mono" />
        </Field>
      </div>
      <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-xs text-slate-500 underline">
        {advanced ? t("treasury.import.hideOptions") : t("treasury.import.showOptions")}
      </button>
      {advanced && kind === "CSV" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label={t("treasury.import.dateFormat")}>
            <Select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as "" | "DMY" | "YMD" | "MDY")}>
              <option value="">{t("treasury.import.auto")}</option>
              <option value="DMY">JJ/MM/AAAA</option>
              <option value="YMD">AAAA-MM-JJ</option>
              <option value="MDY">MM/JJ/AAAA</option>
            </Select>
          </Field>
          <Field label={t("treasury.import.separator")}>
            <Select value={separator} onChange={(e) => setSeparator(e.target.value)}>
              <option value="">{t("treasury.import.auto")}</option>
              <option value=";">;</option>
              <option value=",">,</option>
              <option value={"\t"}>Tab</option>
            </Select>
          </Field>
          <Field label={t("treasury.import.decimalSeparator")}>
            <Select value={decimalSeparator} onChange={(e) => setDecimalSeparator(e.target.value as "" | "," | ".")}>
              <option value="">{t("treasury.import.auto")}</option>
              <option value=",">,</option>
              <option value=".">.</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
            {t("treasury.import.hasHeader")}
          </label>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={bankPerspective} onChange={(e) => setBankPerspective(e.target.checked)} />
            {t("treasury.import.bankPerspective")}
          </label>
        </div>
      ) : null}
      {advanced && kind === "SMS" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t("treasury.import.defaultDate")}>
            <Input type="date" value={defaultDate} onChange={(e) => setDefaultDate(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={includeFees} onChange={(e) => setIncludeFees(e.target.checked)} />
            {t("treasury.import.includeFees")}
          </label>
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <Alert tone={result.parseErrors.length > 0 || result.unparsed.length > 0 ? "warning" : "success"}>
          {t("treasury.import.done", { imported: result.imported, duplicates: result.skippedDuplicates })}
          {result.rowsInClosedPeriods > 0 ? ` · ${t("treasury.import.closedPeriods", { n: result.rowsInClosedPeriods })}` : ""}
          {result.parseErrors.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {result.parseErrors.slice(0, 10).map((e) => (
                <li key={e.line}>
                  {t("treasury.import.line", { n: e.line })} : {e.message}
                </li>
              ))}
            </ul>
          ) : null}
          {result.unparsed.length > 0 ? <p className="mt-1 text-xs">{t("treasury.import.unparsed", { n: result.unparsed.length })}</p> : null}
        </Alert>
      ) : null}
      <Button type="submit" disabled={busy || !text.trim()}>
        {busy ? t("common.loading") : t("treasury.import.submit")}
      </Button>
    </form>
  );
}
