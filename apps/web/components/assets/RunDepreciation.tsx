"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import type { DepreciationRun } from "./types";

/** « Lancer les dotations » d'un exercice (POST /assets/run-depreciation) : une écriture OD unique. */
export function RunDepreciation({ fiscalYear }: { fiscalYear: string }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DepreciationRun | null>(null);
  const [fy, setFy] = useState(fiscalYear);
  const [upToDate, setUpToDate] = useState("");

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient<DepreciationRun>("/assets/run-depreciation", { method: "POST", body: { fiscalYear: fy.trim(), ...(upToDate ? { upToDate } : {}) } });
      setResult(r);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button onClick={() => setOpen(true)} disabled={busy}>
        {t("assets.run.action")}
      </Button>
      {result ? (
        <Alert tone={result.entryId ? "success" : "info"}>
          <p className="font-medium">{result.entryId ? t("assets.run.done", { count: result.rows.length, fy: result.fiscalYearCode, date: result.date }) : t("assets.run.nothing", { fy: result.fiscalYearCode })}</p>
          {result.entryId ? <p className="font-mono text-xs">{result.entryId}</p> : null}
          {result.skipped.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs">
              {result.skipped.map((s) => (
                <li key={s.assetId}>
                  <span className="font-mono">{s.assetId.slice(0, 8)}</span> · {s.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      {error && !open ? <Alert tone="danger">{error}</Alert> : null}
      <ConfirmDialog open={open} title={t("assets.run.action")} busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setOpen(false)}>
        <p>{t("assets.run.confirm")}</p>
        <div className="mt-3 space-y-2">
          <label className="block text-xs">
            {t("common.fiscalYear")}
            <Input value={fy} onChange={(e) => setFy(e.target.value)} className="mt-1 w-32" inputMode="numeric" required />
          </label>
          <label className="block text-xs">
            {t("assets.run.upToDate")} ({t("common.optional")})
            <Input type="date" value={upToDate} onChange={(e) => setUpToDate(e.target.value)} className="mt-1" />
          </label>
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
