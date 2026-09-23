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
import { Field, Input } from "@/components/ui/Field";
import type { PurchaseDocument } from "./types";

type Action = "issue" | "cancel" | "creditNote";

/** Actions d'un document d'achat : comptabiliser (issue), annuler, créer un avoir fournisseur. */
export function PurchaseDocumentActions({ doc }: { doc: PurchaseDocument }) {
  const t = useT();
  const router = useRouter();
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");

  const run = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "issue") {
        const d = await apiClient<PurchaseDocument>(`/purchases/${doc.id}/issue`, { method: "POST" });
        setNotice(t("invoicing.expense.posted", { number: d.number ?? "?" }));
      } else if (action === "cancel") {
        await apiClient<PurchaseDocument>(`/purchases/${doc.id}/cancel`, { method: "POST" });
        setNotice(t("invoicing.actions.cancelled"));
      } else {
        const d = await apiClient<PurchaseDocument>(`/purchases/${doc.id}/credit-note`, { method: "POST", body: { issueDate: date, ...(reference.trim() ? { reference: reference.trim() } : {}) } });
        setAction(null);
        router.push(`/expenses/${d.id}`);
        router.refresh();
        return;
      }
      setAction(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const open = doc.status === "POSTED" || doc.status === "PARTIALLY_PAID";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {doc.status === "DRAFT" ? <Button onClick={() => setAction("issue")}>{t("invoicing.expense.post")}</Button> : null}
        {doc.kind === "SUPPLIER_INVOICE" && (open || doc.status === "PAID") ? <Button variant="secondary" onClick={() => setAction("creditNote")}>{t("invoicing.actions.creditNote")}</Button> : null}
        {doc.status === "DRAFT" || doc.status === "POSTED" ? <Button variant="danger" onClick={() => setAction("cancel")}>{t("invoicing.actions.cancel")}</Button> : null}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <ConfirmDialog
        open={action !== null}
        title={action === "issue" ? t("invoicing.expense.post") : action === "cancel" ? t("invoicing.actions.cancel") : t("invoicing.actions.creditNote")}
        confirmVariant={action === "cancel" ? "danger" : "primary"}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => {
          if (!busy) setAction(null);
        }}
      >
        {action === "issue" ? <p>{t("invoicing.expense.postConfirm")}</p> : null}
        {action === "cancel" ? <p>{t("invoicing.actions.cancelConfirm")}</p> : null}
        {action === "creditNote" ? (
          <div className="space-y-2">
            <p>{t("invoicing.actions.creditNoteConfirm")}</p>
            <Field label={t("invoicing.form.issueDate")}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={`${t("invoicing.expense.reference")} (${t("common.optional")})`}>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
            </Field>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
