"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { inputClass } from "@/components/ui/Field";
import { documentStatusTone } from "./helpers";
import { ProposalCard } from "./ProposalCard";
import { ProposalEditor } from "./ProposalEditor";
import type { BulkValidateItem, DecisionResult, ProposalLine, ProposalRecord, ReviewQueueGroup } from "./types";

interface Notice {
  tone: "success" | "danger" | "info";
  text: string;
}

/**
 * File de revue du comptable, groupée par pièce : valider en un geste,
 * corriger (lignes + sélecteur de compte), rejeter (motif), validation en lot.
 * Les propositions décidées disparaissent de la liste ; l'écran est ensuite
 * resynchronisé avec le serveur.
 */
export function ReviewQueue({ groups: initial, currency }: { groups: ReviewQueueGroup[]; currency: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [groups, setGroups] = useState(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ProposalRecord | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const all = useMemo(() => groups.flatMap((g) => g.proposals), [groups]);
  const allSelected = all.length > 0 && all.every((p) => selected.has(p.id));

  const remove = (ids: string[]) => {
    const gone = new Set(ids);
    setGroups((gs) => gs.map((g) => ({ ...g, proposals: g.proposals.filter((p) => !gone.has(p.id)) })).filter((g) => g.proposals.length > 0));
    setSelected((s) => new Set([...s].filter((id) => !gone.has(id))));
  };

  const decide = async (p: ProposalRecord, action: "validate" | "reject" | "correct", lines?: ProposalLine[]) => {
    setBusy(p.id);
    setNotice(null);
    try {
      if (action === "validate") {
        const r = await apiClient<DecisionResult>(`/proposals/${p.id}/validate`, { method: "POST" });
        setNotice({ tone: "success", text: t("documents.review.validated", { number: r.entry.number ?? "?", journal: r.entry.journalCode }) });
      } else if (action === "correct") {
        const r = await apiClient<DecisionResult>(`/proposals/${p.id}/correct`, { method: "POST", body: { lines } });
        setNotice({ tone: "success", text: t("documents.review.corrected", { number: r.entry.number ?? "?", journal: r.entry.journalCode }) });
        setEditing(null);
      } else {
        await apiClient<ProposalRecord>(`/proposals/${p.id}/reject`, { method: "POST", body: reason.trim() ? { reason: reason.trim() } : {} });
        setNotice({ tone: "info", text: t("documents.review.rejected") });
        setRejecting(null);
        setReason("");
      }
      remove([p.id]);
      router.refresh();
    } catch (e) {
      setNotice({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const bulk = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy("bulk");
    setNotice(null);
    try {
      const results = await apiClient<BulkValidateItem[]>("/proposals/bulk-validate", { method: "POST", body: { ids } });
      const ok = results.filter((r) => r.ok).map((r) => r.id);
      const ko = results.filter((r) => !r.ok);
      remove(ok);
      setNotice({ tone: ko.length ? "danger" : "success", text: `${t("documents.review.bulkDone", { ok: ok.length, ko: ko.length })}${ko.length ? " — " + ko.map((r) => `${r.id.slice(0, 8)}: ${r.error?.message ?? r.error?.code ?? "?"}`).join(" ; ") : ""}` });
      router.refresh();
    } catch (e) {
      setNotice({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (groups.length === 0) {
    return (
      <>
        {notice ? <Alert tone={notice.tone} className="mb-4">{notice.text}</Alert> : null}
        <EmptyState title={t("documents.review.empty")} icon="✔" />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-14 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(all.map((p) => p.id)))} />
          {t("documents.review.selectAll")}
        </label>
        <span className="text-xs text-slate-500">{t("documents.review.selected", { n: selected.size })}</span>
        <Button size="sm" onClick={() => void bulk()} disabled={selected.size === 0 || busy !== null} className="ml-auto">
          {busy === "bulk" ? t("common.loading") : t("documents.review.bulkValidate")}
        </Button>
      </div>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {groups.map((g) => (
        <section key={g.document?.id ?? g.proposals[0]!.id} className="space-y-3">
          <header className="flex flex-wrap items-center gap-2 text-sm">
            {g.document ? (
              <>
                <Link href={`/documents/${g.document.id}`} className="font-medium underline">{g.document.filename ?? g.document.id}</Link>
                <Badge tone={documentStatusTone(g.document.status)}>{t(`documents.status.${g.document.status}`)}</Badge>
                <Badge tone="neutral">{t(`documents.source.${g.document.source}`)}</Badge>
                <span className="text-xs text-slate-500">{formatDate(locale, g.document.createdAt)}</span>
                <a href={`/api/proxy/documents/${g.document.id}/download`} target="_blank" rel="noreferrer" className="text-xs underline">{t("documents.download")}</a>
              </>
            ) : (
              <span className="text-slate-500">{t("documents.review.noDocument")}</span>
            )}
          </header>
          {g.proposals.map((p) => (
            <div key={p.id} className="flex gap-3">
              <input type="checkbox" className="mt-4" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={p.proposal.label} />
              <div className="min-w-0 flex-1">
                {editing === p.id ? (
                  <div className="space-y-3">
                    <ProposalCard proposal={p} currency={currency} compact actions={<span className="text-xs text-slate-500">{t("documents.review.correct")}</span>} />
                    <ProposalEditor lines={p.correction ?? p.proposal.lines} currency={currency} busy={busy === p.id} onSubmit={(lines) => void decide(p, "correct", lines)} onCancel={() => setEditing(null)} />
                  </div>
                ) : (
                  <ProposalCard
                    proposal={p}
                    currency={currency}
                    actions={
                      <>
                        <Button size="sm" onClick={() => void decide(p, "validate")} disabled={busy !== null || p.route === "REJECTED"}>
                          {busy === p.id ? t("common.loading") : t("documents.review.validate")}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(p.id)} disabled={busy !== null}>
                          {t("documents.review.correct")}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setRejecting(p)} disabled={busy !== null}>
                          {t("documents.review.reject")}
                        </Button>
                      </>
                    }
                  />
                )}
              </div>
            </div>
          ))}
        </section>
      ))}

      <ConfirmDialog
        open={rejecting !== null}
        title={t("documents.review.reject")}
        confirmLabel={t("documents.review.reject")}
        confirmVariant="danger"
        busy={busy !== null && rejecting !== null && busy === rejecting.id}
        onConfirm={() => rejecting && void decide(rejecting, "reject")}
        onCancel={() => {
          if (busy === null) setRejecting(null);
        }}
      >
        <p>{t("documents.review.rejectConfirm")}</p>
        <label className="mt-3 block text-xs">
          {t("documents.review.rejectReason")} ({t("common.optional")})
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} className={`${inputClass} mt-1`} />
        </label>
      </ConfirmDialog>
    </div>
  );
}
