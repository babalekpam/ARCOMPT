// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";

/** Sortie d'un salarié : désactivation avec date de départ (jamais de suppression). */
export function EmployeeDeactivate({ id, name }: { id: string; name: string }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveDate, setLeaveDate] = useState(new Date().toISOString().slice(0, 10));
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient<void>(`/payroll/employees/${id}`, { method: "DELETE", query: { leaveDate } });
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        {t("payroll.employee.deactivate")}
      </Button>
      <ConfirmDialog open={open} title={t("payroll.employee.deactivate")} confirmVariant="danger" busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setOpen(false)}>
        <p>{t("payroll.employee.deactivateConfirm", { name })}</p>
        <label className="mt-3 block text-xs">
          {t("payroll.employee.leaveDate")}
          <Input type="date" value={leaveDate} onChange={(e) => setLeaveDate(e.target.value)} className="mt-1" />
        </label>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </ConfirmDialog>
    </>
  );
}
