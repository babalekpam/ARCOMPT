"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import { periodCode, periodTone } from "./helpers";
import type { PeriodInfo } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Dialog = { kind: "close"; period: PeriodInfo } | { kind: "unlock"; period: PeriodInfo } | null;

/** Périodes de l'exercice : clôture et déverrouillage (commentaire + approbateur distinct). */
export function PeriodsTable({ periods, currentUserId }: { periods: PeriodInfo[]; currentUserId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [approverId, setApproverId] = useState("");

  const run = async () => {
    if (!dialog) return;
    setError(null);
    if (dialog.kind === "unlock") {
      if (comment.trim().length < 5) return setError(t("closing.unlock.errorComment"));
      if (!UUID_RE.test(approverId.trim())) return setError(t("closing.unlock.errorApprover"));
      if (approverId.trim().toLowerCase() === currentUserId.toLowerCase()) return setError(t("closing.unlock.errorSelf"));
    }
    setBusy(true);
    setSuccess(null);
    try {
      const p = dialog.kind === "close" ? await apiClient<PeriodInfo>(`/closing/periods/${dialog.period.id}/close`, { method: "POST" }) : await apiClient<PeriodInfo>(`/closing/periods/${dialog.period.id}/unlock`, { method: "POST", body: { comment: comment.trim(), approverId: approverId.trim() } });
      setSuccess(dialog.kind === "close" ? t("closing.periods.closed", { period: periodCode(p.startDate) }) : t("closing.periods.unlocked", { period: periodCode(p.startDate) }));
      setDialog(null);
      setComment("");
      setApproverId("");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (periods.length === 0) return <p className="text-sm text-slate-500">{t("closing.periods.empty")}</p>;

  return (
    <div className="space-y-3">
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2 pr-3">{t("closing.period")}</th>
              <th className="py-2 pr-3">{t("common.from")}</th>
              <th className="py-2 pr-3">{t("common.to")}</th>
              <th className="py-2 pr-3">{t("common.status")}</th>
              <th className="py-2 text-right">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {periods.map((p) => (
              <tr key={p.id}>
                <td className="py-1.5 pr-3 font-mono text-xs">
                  {periodCode(p.startDate)}
                  {p.isLast ? <Badge tone="info" className="ml-2">{t("closing.periods.last")}</Badge> : null}
                </td>
                <td className="py-1.5 pr-3">{formatDate(locale, p.startDate)}</td>
                <td className="py-1.5 pr-3">{formatDate(locale, p.endDate)}</td>
                <td className="py-1.5 pr-3"><Badge tone={periodTone(p.status)}>{t(`closing.periodStatus.${p.status}`)}</Badge></td>
                <td className="py-1.5 text-right">
                  {p.status === "OPEN" ? (
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "close", period: p })} disabled={busy}>
                      {t("closing.periods.close")}
                    </Button>
                  ) : null}
                  {p.status === "CLOSED" ? (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "unlock", period: p })} disabled={busy}>
                      {t("closing.periods.unlock")}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && !dialog ? <Alert tone="danger">{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      <ConfirmDialog open={dialog?.kind === "close"} title={t("closing.periods.close")} busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("closing.periods.closeConfirm", { period: dialog ? periodCode(dialog.period.startDate) : "" })}</p>
        <p className="mt-1 text-xs text-slate-500">{dialog?.period.isLast ? t("closing.periods.closeLastHint") : t("closing.periods.closeHint")}</p>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </ConfirmDialog>

      <ConfirmDialog open={dialog?.kind === "unlock"} title={t("closing.periods.unlock")} confirmVariant="danger" busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setDialog(null)}>
        <p>{t("closing.unlock.confirm", { period: dialog ? periodCode(dialog.period.startDate) : "" })}</p>
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t("closing.unlock.separation")}</p>
        <div className="mt-3 space-y-2">
          <label className="block text-xs">
            {t("closing.unlock.comment")}
            <Input value={comment} onChange={(e) => setComment(e.target.value)} className="mt-1" maxLength={2000} placeholder={t("closing.unlock.commentPlaceholder")} />
          </label>
          <label className="block text-xs">
            {t("closing.unlock.approver")}
            <Input value={approverId} onChange={(e) => setApproverId(e.target.value)} className="mt-1 font-mono text-xs" placeholder="00000000-0000-0000-0000-000000000000" />
            <span className="mt-1 block text-[11px] text-slate-500">{t("closing.unlock.approverHint")}</span>
          </label>
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
