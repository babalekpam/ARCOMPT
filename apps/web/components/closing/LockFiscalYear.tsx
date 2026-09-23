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
import type { FiscalYearRow } from "./types";

/** Verrouillage définitif de l'exercice (toutes les périodes passent LOCKED). */
export function LockFiscalYear({ fiscalYear, disabled = false }: { fiscalYear: string; disabled?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient<FiscalYearRow>(`/closing/fiscal-years/${encodeURIComponent(fiscalYear)}/lock`, { method: "POST" });
      setDone(true);
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
      <Button variant="danger" size="sm" onClick={() => setOpen(true)} disabled={disabled || busy || done}>
        {t("closing.lock.action")}
      </Button>
      {done ? <Alert tone="success">{t("closing.lock.done", { fy: fiscalYear })}</Alert> : null}
      {error && !open ? <Alert tone="danger">{error}</Alert> : null}
      <ConfirmDialog open={open} title={t("closing.lock.action")} confirmVariant="danger" busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setOpen(false)}>
        <p>{t("closing.lock.confirm", { fy: fiscalYear })}</p>
        <p className="mt-1 text-xs text-slate-500">{t("closing.lock.hint")}</p>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </ConfirmDialog>
    </div>
  );
}
