"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import type { PayrollDeclaration } from "./types";

/** « Marquer déposée » : enregistre la référence de dépôt d'une déclaration sociale / fiscale. */
export function DeclarationFileButton({ declaration }: { declaration: PayrollDeclaration }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const run = async () => {
    if (!reference.trim()) return setError(t("payroll.declarations.errorReference"));
    setBusy(true);
    setError(null);
    try {
      await apiClient<PayrollDeclaration>(`/payroll/declarations/${declaration.id}/file`, { method: "POST", body: { filingReference: reference.trim() } });
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {t("payroll.declarations.markFiled")}
      </Button>
      <ConfirmDialog open={open} title={t("payroll.declarations.markFiled")} busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setOpen(false)}>
        <p>{t("payroll.declarations.markFiledConfirm", { label: declaration.label })}</p>
        <label className="mt-3 block text-xs">
          {t("payroll.declarations.filingReference")}
          <Input value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1" maxLength={120} />
        </label>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </ConfirmDialog>
    </>
  );
}
