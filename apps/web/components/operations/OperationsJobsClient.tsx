"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type JobName = "document.extract" | "import.statement" | "dunning.send" | string;
type ReviewOutcome = "DELIVERED" | "NOT_DELIVERED";

interface FailedJob {
  id: string;
  name: JobName;
  status: string;
  attempts: number;
  last_error?: string | null;
  created_at: string;
  resource_id?: string | null;
  channel?: string | null;
  review_outcome?: ReviewOutcome | null;
  reviewed_at?: string | null;
}

interface ReviewDraft {
  outcome: ReviewOutcome | "";
  confirmed: boolean;
}

const jobLabels: Record<string, string> = {
  "document.extract": "Extraction de document",
  "import.statement": "Import de relevé",
  "dunning.send": "Rappel client",
};

const jobDescriptions: Record<string, string> = {
  "document.extract": "La pièce n’a pas pu être analysée automatiquement.",
  "import.statement": "Le relevé n’a pas pu être importé dans la trésorerie.",
  "dunning.send": "Le rappel n’a pas pu être confirmé comme envoyé.",
};

function resourceHref(job: FailedJob): string | null {
  if (!job.resource_id) return null;
  if (job.name === "document.extract") return `/documents/${job.resource_id}`;
  if (job.name === "import.statement") return `/treasury/${job.resource_id}`;
  if (job.name === "dunning.send") return `/invoices/${job.resource_id}`;
  return null;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function jobTone(name: string): "neutral" | "warning" | "danger" {
  if (name === "dunning.send") return "warning";
  if (name === "import.statement") return "neutral";
  return "danger";
}

function ResourceLink({ job }: { job: FailedJob }) {
  const href = resourceHref(job);
  if (!href) return <span className="text-slate-400">Non rattaché</span>;
  const label = job.name === "document.extract" ? "Ouvrir le document" : job.name === "import.statement" ? "Ouvrir le relevé" : "Ouvrir la facture";
  return <Link href={href} className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900 dark:text-slate-100">{label}</Link>;
}

function ReviewPanel({ job, onDone }: { job: FailedJob; onDone: () => void }) {
  const [draft, setDraft] = useState<ReviewDraft>({ outcome: "", confirmed: false });
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submitReview() {
    if (!draft.outcome || !draft.confirmed) return;
    setState("loading");
    setMessage("");
    try {
      await apiClient(`/jobs/${job.id}/review`, { method: "POST", body: { outcome: draft.outcome, confirmed: true } });
      setState("success");
      setMessage(draft.outcome === "DELIVERED" ? "Rappel marqué comme délivré." : "Rappel marqué comme non délivré. Un nouveau rappel est programmé.");
      onDone();
    } catch (error) {
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/70 dark:bg-amber-950/20">
      <p className="text-sm font-semibold text-amber-950 dark:text-amber-100">Vérification requise avant de clôturer</p>
      <p className="mt-1 text-sm leading-5 text-amber-900/80 dark:text-amber-200/80">
        Consultez le canal externe ({job.channel || "canal non précisé"}) et vérifiez l’état de livraison. Ce rappel ne peut pas être relancé directement.
      </p>
      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">Résultat de la vérification</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-800 dark:text-slate-100">
          <input type="radio" name={`outcome-${job.id}`} checked={draft.outcome === "DELIVERED"} onChange={() => setDraft((current) => ({ ...current, outcome: "DELIVERED" }))} className="mt-0.5 accent-slate-900" />
          <span><strong>Délivré</strong><span className="block text-xs text-slate-500">Le client a bien reçu le rappel.</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-800 dark:text-slate-100">
          <input type="radio" name={`outcome-${job.id}`} checked={draft.outcome === "NOT_DELIVERED"} onChange={() => setDraft((current) => ({ ...current, outcome: "NOT_DELIVERED" }))} className="mt-0.5 accent-slate-900" />
          <span><strong>Non délivré</strong><span className="block text-xs text-slate-500">Un nouveau rappel sera planifié.</span></span>
        </label>
      </fieldset>
      <label className="mt-4 flex cursor-pointer items-start gap-2 border-t border-amber-200 pt-3 text-sm text-slate-800 dark:border-amber-900/60 dark:text-slate-100">
        <input type="checkbox" checked={draft.confirmed} onChange={(event) => setDraft((current) => ({ ...current, confirmed: event.target.checked }))} className="mt-0.5 accent-slate-900" />
        <span>Je confirme avoir vérifié la livraison sur le canal externe et reconnais ce résultat.</span>
      </label>
      {message ? <p className={`mt-3 text-sm ${state === "error" ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`} role={state === "error" ? "alert" : "status"}>{message}</p> : null}
      {state !== "success" ? (
        <Button size="sm" className="mt-3" onClick={submitReview} disabled={!draft.outcome || !draft.confirmed || state === "loading"}>
          {state === "loading" ? "Enregistrement…" : "Enregistrer la vérification"}
        </Button>
      ) : null}
    </div>
  );
}

export function OperationsJobsClient() {
  const [jobs, setJobs] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [remindersToReview, setRemindersToReview] = useState<number | null>(null);

  const loadJobs = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const data = await apiClient<FailedJob[]>("/jobs", { query: { status: "FAILED" } });
      setJobs(Array.isArray(data) ? data : []);
      try {
        const reminderCount = await apiClient<{ count: number }>("/jobs/review-count", { cache: "no-store" });
        setRemindersToReview(reminderCount.count);
        window.dispatchEvent(new Event("reminder-review-changed"));
      } catch {
        setRemindersToReview(null);
      }
    } catch (requestError) {
      setRemindersToReview(null);
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  async function retryJob(job: FailedJob) {
    setRetryingId(job.id);
    setNotice("");
    try {
      await apiClient(`/jobs/${job.id}/retry`, { method: "POST", body: {} });
      setNotice("Le travail a été remis en file d’attente.");
      await loadJobs(true);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setRetryingId(null);
    }
  }

  const retryableCount = useMemo(() => jobs.filter((job) => job.name === "document.extract" || job.name === "import.statement").length, [jobs]);

  return (
    <section className="space-y-5" aria-labelledby="operations-jobs-title">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Opérations / supervision</p>
          <h1 id="operations-jobs-title" className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">Travaux en échec</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-300">Examinez les traitements interrompus avant de les relancer. Les rappels clients exigent une vérification de livraison.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void loadJobs(true)} disabled={loading || refreshing}>{refreshing ? "Actualisation…" : "Actualiser"}</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60"><p className="text-xs uppercase tracking-wide text-slate-500">À examiner</p><p className="mt-1 text-2xl font-semibold text-slate-950 dark:text-white">{loading ? "—" : jobs.filter((job) => !job.review_outcome).length}</p></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60"><p className="text-xs uppercase tracking-wide text-slate-500">Relançables</p><p className="mt-1 text-2xl font-semibold text-slate-950 dark:text-white">{loading ? "—" : retryableCount}</p></div>
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/20"><p className="text-xs uppercase tracking-wide text-amber-800 dark:text-amber-200">Rappels à vérifier</p><p className="mt-1 text-2xl font-semibold text-amber-950 dark:text-amber-100">{loading ? "—" : remindersToReview ?? "—"}</p></div>
      </div>

      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200" role="status">{notice}</p> : null}
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" role="alert"><p>{error}</p><Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadJobs()}>Réessayer</Button></div> : null}

      {loading ? (
        <Card><div className="space-y-3" aria-label="Chargement"><div className="h-5 w-48 animate-pulse rounded bg-slate-200 dark:bg-slate-800" /><div className="h-16 animate-pulse rounded bg-slate-100 dark:bg-slate-900" /><div className="h-16 animate-pulse rounded bg-slate-100 dark:bg-slate-900" /></div></Card>
      ) : jobs.length === 0 && !error ? (
        <Card><div className="py-10 text-center"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"><span className="h-2.5 w-2.5 rounded-full bg-current" /></div><h2 className="mt-3 text-base font-semibold text-slate-900 dark:text-white">Aucun échec en attente</h2><p className="mt-1 text-sm text-slate-500">Les traitements récents ne nécessitent aucune intervention.</p></div></Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Card key={job.id} className="overflow-hidden">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><Badge tone={jobTone(job.name)}>{jobLabels[job.name] || job.name}</Badge><span className="text-xs text-slate-500">Échec · {job.attempts} tentative{job.attempts > 1 ? "s" : ""}</span></div>
                  <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{jobDescriptions[job.name] || "Ce traitement nécessite une vérification."}</p>
                  <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2"><p><span className="font-medium text-slate-600 dark:text-slate-300">Créé le</span><br />{formatDate(job.created_at)}</p><p><span className="font-medium text-slate-600 dark:text-slate-300">Ressource</span><br /><ResourceLink job={job} /></p></div>
                  {job.last_error ? <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-300">Voir le motif technique</summary><p className="mt-1 max-w-3xl break-words rounded bg-slate-50 p-2 font-mono dark:bg-slate-900">{job.last_error}</p></details> : null}
                </div>
                <div className="shrink-0">
                   {job.name === "dunning.send" ? job.review_outcome
                     ? <p className="text-sm text-emerald-700 dark:text-emerald-300" role="status">Vérifié : {job.review_outcome === "DELIVERED" ? "délivré" : "non délivré — nouveau rappel programmé"}</p>
                     : <Button variant="secondary" size="sm" onClick={() => setReviewingId((current) => current === job.id ? null : job.id)}>{reviewingId === job.id ? "Masquer la vérification" : "Vérifier la livraison"}</Button>
                     : job.name === "document.extract" || job.name === "import.statement"
                       ? <Button size="sm" onClick={() => void retryJob(job)} disabled={retryingId === job.id}>{retryingId === job.id ? "Relance…" : "Relancer le traitement"}</Button>
                       : null}
                </div>
              </div>
               {job.name === "dunning.send" && !job.review_outcome && reviewingId === job.id ? <ReviewPanel job={job} onDone={() => { setReviewingId(null); void loadJobs(true); }} /> : null}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}