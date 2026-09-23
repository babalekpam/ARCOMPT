// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, ApiError, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input } from "@/components/ui/Field";
import type { Payment } from "./types";

/**
 * Approuver / refuser un règlement en attente (PENDING_APPROVAL) ou en revue
 * (REVIEW). Séparation des tâches : l'API refuse (SAME_USER) si l'approbateur
 * est l'auteur du règlement ; le message est affiché tel quel.
 */
export function PaymentActions({ payment, onDone }: { payment: Payment; onDone?: () => void }) {
  const t = useT();
  const router = useRouter();
  const [action, setAction] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (payment.status !== "PENDING_APPROVAL" && payment.status !== "REVIEW") return null;

  const run = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "approve") await apiClient<Payment>(`/payments/${payment.id}/approve`, { method: "POST", body: {} });
      else {
        if (!reason.trim()) {
          setError(t("invoicing.payments.reasonRequired"));
          setBusy(false);
          return;
        }
        await apiClient<Payment>(`/payments/${payment.id}/reject`, { method: "POST", body: { reason: reason.trim() } });
      }
      setAction(null);
      onDone?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "SAME_USER" ? `${t("invoicing.payments.sameUser")} — ${e.message}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button size="sm" onClick={() => setAction("approve")}>
        {t("invoicing.payments.approve")}
      </Button>
      <Button size="sm" variant="danger" onClick={() => setAction("reject")}>
        {t("invoicing.payments.reject")}
      </Button>
      {error ? <span className="basis-full text-xs text-red-600">{error}</span> : null}
      <ConfirmDialog
        open={action !== null}
        title={action === "approve" ? t("invoicing.payments.approve") : t("invoicing.payments.reject")}
        confirmVariant={action === "reject" ? "danger" : "primary"}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => {
          if (!busy) setAction(null);
        }}
      >
        <Alert tone="info" className="mb-2">{t("invoicing.payments.sodHint")}</Alert>
        {action === "approve" ? <p>{t("invoicing.payments.approveConfirm", { number: payment.number })}</p> : null}
        {action === "reject" ? (
          <div className="space-y-2">
            <p>{t("invoicing.payments.rejectConfirm", { number: payment.number })}</p>
            <Field label={t("invoicing.payments.reason")}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required />
            </Field>
          </div>
        ) : null}
        {payment.reviewReason ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{payment.reviewReason}</p> : null}
        <p className="mt-2 font-mono text-[11px] text-slate-400">{t("invoicing.payments.createdBy")} {payment.createdBy}</p>
      </ConfirmDialog>
    </div>
  );
}
