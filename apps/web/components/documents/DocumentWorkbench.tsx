"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, LinkButton } from "@/components/ui/Button";
import { ExtractionCard } from "./ExtractionCard";
import { documentStatusTone, formatBytes } from "./helpers";
import { ProposalCard } from "./ProposalCard";
import type { DocumentRecord, ExtractResult, ProposalRecord } from "./types";

/**
 * Atelier d'une pièce : fiche, lien de téléchargement, puis « Extraire » et
 * « Proposer une écriture ». L'extraction et la proposition affichées sont
 * celles renvoyées par l'API ; rien n'est comptabilisé ici.
 */
export function DocumentWorkbench({ document: initial, currency, proposals = [], showLink = false }: { document: DocumentRecord; currency: string; proposals?: ProposalRecord[]; showLink?: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [doc, setDoc] = useState(initial);
  const [extract, setExtract] = useState<ExtractResult | null>(initial.extracted ? { document: initial, extraction: initial.extracted, issues: initial.extracted.issues ?? [], needsOcr: initial.extracted.needs_ocr ?? false } : null);
  const [proposal, setProposal] = useState<ProposalRecord | null>(null);
  const [busy, setBusy] = useState<"extract" | "propose" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: "extract" | "propose") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "extract") {
        const r = await apiClient<ExtractResult>(`/documents/${doc.id}/extract`, { method: "POST" });
        setExtract(r);
        setDoc(r.document);
      } else {
        const p = await apiClient<ProposalRecord>(`/documents/${doc.id}/propose`, { method: "POST" });
        setProposal(p);
        if (p.extraction) setExtract({ document: doc, extraction: p.extraction, issues: p.extraction.issues ?? [], needsOcr: p.extraction.needs_ocr ?? false });
        setDoc((d) => ({ ...d, status: "PROPOSED" }));
        router.refresh();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const others = proposals.filter((p) => p.id !== proposal?.id);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto truncate font-medium">{doc.filename ?? doc.id}</span>
          <Badge tone="neutral">{t(`documents.source.${doc.source}`)}</Badge>
          <Badge tone={documentStatusTone(doc.status)}>{t(`documents.status.${doc.status}`)}</Badge>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {doc.mimeType} · {formatBytes(doc.sizeBytes)} · {formatDate(locale, doc.createdAt)} · <span className="font-mono">{doc.id}</span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void run("extract")} disabled={busy !== null}>
            {busy === "extract" ? t("documents.actions.extracting") : t("documents.actions.extract")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void run("propose")} disabled={busy !== null}>
            {busy === "propose" ? t("documents.actions.proposing") : t("documents.actions.propose")}
          </Button>
          <LinkButton href={`/api/proxy/documents/${doc.id}/download`} variant="ghost" size="sm" external>
            {t("documents.download")}
          </LinkButton>
          {showLink ? (
            <LinkButton href={`/documents/${doc.id}`} variant="ghost" size="sm">
              {t("documents.open")}
            </LinkButton>
          ) : null}
        </div>
        {error ? <Alert tone="danger" className="mt-3">{error}</Alert> : null}
      </div>
      {extract ? <ExtractionCard extraction={extract.extraction} issues={extract.issues} needsOcr={extract.needsOcr} fallbackCurrency={currency} /> : null}
      {proposal ? <ProposalCard proposal={proposal} currency={currency} /> : null}
      {others.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{t("documents.detail.proposals")}</h3>
          {others.map((p) => (
            <ProposalCard key={p.id} proposal={p} currency={currency} compact />
          ))}
        </div>
      ) : null}
    </div>
  );
}
