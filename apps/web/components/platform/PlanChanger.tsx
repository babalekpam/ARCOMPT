"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient, errorMessage } from "@/lib/api-client";
import { PLANS, formatCfa } from "@/lib/plans";
import { Input, Select } from "@/components/ui/Field";

/** Changement d'offre manuel d'une organisation (administration plateforme). */
export function PlanChanger({ organizationId, currentPlan }: { organizationId: string; currentPlan: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [planCode, setPlanCode] = useState(currentPlan);
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [endedAt, setEndedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function save() {
    setBusy(true); setMsg(""); setError("");
    try {
      const result = await apiClient<{ ok: boolean; planCode: string; previousPlan: string | null }>(
        `/platform/organizations/${organizationId}/subscription`,
        { method: "PUT", body: { planCode, startedAt: startedAt || null, endedAt: endedAt || null } },
      );
      setMsg(`Offre mise à jour : ${result.previousPlan ?? "—"} → ${result.planCode}. Changement journalisé.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">
          Changer l’offre
        </button>
        {msg ? <p role="status" className="mt-2 text-xs text-teal-700 dark:text-teal-300">{msg}</p> : null}
        {error ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600 dark:text-slate-300">
          Nouvelle offre
          <Select value={planCode} onChange={(e) => setPlanCode(e.target.value)} className="mt-1" aria-label="Nouvelle offre">
            {PLANS.map((p) => (
              <option key={p.code} value={p.code}>{p.label} — {p.price === 0 ? "gratuit" : `${formatCfa(p.price)}/dossier/mois`}</option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-300">
          Début
          <Input type="date" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} className="mt-1" aria-label="Date de début" />
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-300">
          Fin (optionnel)
          <Input type="date" value={endedAt} onChange={(e) => setEndedAt(e.target.value)} className="mt-1" aria-label="Date de fin" />
        </label>
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
          {busy ? "Enregistrement…" : "Appliquer"}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold hover:bg-white dark:border-slate-600">
          Annuler
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
      <p className="mt-2 text-[11px] text-slate-500">Le changement est appliqué immédiatement et inscrit au journal d’administration.</p>
    </div>
  );
}
