// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import { allowedTransitions, type WorkflowEdge } from "./helpers";
import { WORKFLOW_STATES, type FiscalYearWorkflow } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Workflow de l'exercice : TENUE → REVISION → ETATS → VISA → DEPOT → VERROUILLE.
 * Les transitions proposées suivent la machine à états ; l'API applique les
 * rôles et la séparation des tâches (celui qui a produit les états ne vise pas).
 */
export function WorkflowCard({ workflow }: { workflow: FiscalYearWorkflow }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [edge, setEdge] = useState<WorkflowEdge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [receipt, setReceipt] = useState(workflow.filingReceiptDocumentId ?? "");
  const current = WORKFLOW_STATES.indexOf(workflow.state);

  const run = async () => {
    if (!edge) return;
    setError(null);
    if (edge.receiptRequired && !UUID_RE.test(receipt.trim())) return setError(t("closing.workflow.errorReceipt"));
    setBusy(true);
    setSuccess(null);
    try {
      const wf = await apiClient<FiscalYearWorkflow>(`/closing/fiscal-years/${encodeURIComponent(workflow.fiscalYearCode)}/workflow`, {
        method: "POST",
        body: { to: edge.to, ...(comment.trim() ? { comment: comment.trim() } : {}), ...(edge.receiptRequired && receipt.trim() ? { filingReceiptDocumentId: receipt.trim() } : {}) },
      });
      setSuccess(t("closing.workflow.moved", { state: t(`closing.state.${wf.state}`) }));
      setEdge(null);
      setComment("");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-1 text-xs">
        {WORKFLOW_STATES.map((s, i) => (
          <li key={s} className="flex items-center gap-1">
            <span className={`rounded-full px-2.5 py-1 font-medium ${i === current ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : i < current ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"}`}>
              {t(`closing.state.${s}`)}
            </span>
            {i < WORKFLOW_STATES.length - 1 ? <span className="text-slate-300">→</span> : null}
          </li>
        ))}
      </ol>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t(`closing.stateHint.${workflow.state}`)}</p>
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">{t("closing.workflow.reviewer")}</dt>
          <dd className="font-mono">{workflow.reviewerId ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t("closing.workflow.approver")}</dt>
          <dd className="font-mono">{workflow.approverId ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t("closing.workflow.receipt")}</dt>
          <dd className="font-mono">{workflow.filingReceiptDocumentId ?? "—"}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        {allowedTransitions(workflow.state).map((e) => (
          <Button key={e.to} variant={e.backward ? "secondary" : "primary"} size="sm" onClick={() => setEdge(e)} disabled={busy}>
            {t(e.labelKey)} → {t(`closing.state.${e.to}`)}
          </Button>
        ))}
        {workflow.state === "VERROUILLE" ? <span className="text-sm text-slate-500">{t("closing.workflow.lockedNotice")}</span> : null}
      </div>
      {error && !edge ? <Alert tone="danger">{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}
      {workflow.history.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500">{t("closing.workflow.history", { count: workflow.history.length })}</summary>
          <ul className="mt-2 space-y-1">
            {[...workflow.history].reverse().map((h, i) => (
              <li key={i} className="flex flex-wrap gap-2">
                <span className="text-slate-500">{formatDate(locale, h.at)}</span>
                <span>
                  {t(`closing.state.${h.from}`)} → <span className="font-medium">{t(`closing.state.${h.to}`)}</span>
                </span>
                <span className="font-mono text-slate-400">{h.by}</span>
                {h.comment ? <span className="italic text-slate-600 dark:text-slate-300">« {h.comment} »</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ConfirmDialog open={edge !== null} title={edge ? `${t(edge.labelKey)} → ${t(`closing.state.${edge.to}`)}` : ""} confirmVariant={edge?.backward ? "danger" : "primary"} busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setEdge(null)}>
        {edge ? <p>{t(`closing.transitionHint.${edge.from}_${edge.to}`)}</p> : null}
        <div className="mt-3 space-y-2">
          <label className="block text-xs">
            {t("closing.workflow.comment")} ({edge?.commentHint ? t("closing.workflow.commentExpected") : t("common.optional")})
            <Input value={comment} onChange={(e) => setComment(e.target.value)} className="mt-1" maxLength={2000} />
          </label>
          {edge?.receiptRequired ? (
            <label className="block text-xs">
              {t("closing.workflow.receipt")}
              <Input value={receipt} onChange={(e) => setReceipt(e.target.value)} className="mt-1 font-mono text-xs" placeholder="00000000-0000-0000-0000-000000000000" />
              <span className="mt-1 block text-[11px] text-slate-500">{t("closing.workflow.receiptHint")}</span>
            </label>
          ) : null}
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
