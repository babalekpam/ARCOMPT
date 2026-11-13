"use client";
import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

type Summary = {
  companyName: string;
  counts: {
    partners: number; products: number; salesDocuments: number; purchaseDocuments: number;
    employees: number; bankTransactions: number; journalEntries: number; documents: number;
  };
};

function errText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; error?: unknown };
    if (typeof o.message === "string" && o.message) return o.message;
    if (o.error && o.error !== e) return errText(o.error, fallback);
  }
  return fallback;
}

function normalizeName(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
}

const COUNT_LABELS: [keyof Summary["counts"], string][] = [
  ["partners", "clients et fournisseurs"],
  ["products", "produits"],
  ["salesDocuments", "factures et devis de vente"],
  ["purchaseDocuments", "documents d’achat"],
  ["employees", "employés"],
  ["bankTransactions", "opérations bancaires"],
  ["journalEntries", "écritures comptables"],
  ["documents", "documents joints"],
];

/**
 * Zone sensible — réinitialisation des données métier du dossier.
 * Visible uniquement pour le rôle OWNER : le résumé vient d’un endpoint
 * réservé aux propriétaires ; tout autre rôle reçoit un refus et la carte
 * ne s’affiche pas. La confirmation exige la saisie exacte du nom du
 * dossier, vérifiée côté serveur.
 */
export function ResetDataCard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiClient("/company/reset-summary")
      .then((j) => { const v = j as Summary; if (v && typeof v.companyName === "string") setSummary(v); })
      .catch(() => { /* non propriétaire ou indisponible : la carte reste masquée */ });
  }, []);

  if (!summary) return null;

  const matches = normalizeName(confirmName) === normalizeName(summary.companyName);
  const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);

  async function reset() {
    setBusy(true); setMsg("");
    try {
      await apiClient("/company/reset-data", { method: "POST", body: { confirmName } });
      setDone(true);
      setMsg("Dossier réinitialisé : les données métier ont été supprimées, la structure est conservée.");
    } catch (e) {
      setMsg(errText(e, "Échec de la réinitialisation."));
    } finally { setBusy(false); }
  }

  const isError = /échec|erreur|incorrecte/i.test(msg);

  return (
    <Card>
      <CardTitle hint="Action irréversible, réservée au propriétaire du dossier.">
        <span className="text-red-700 dark:text-red-400">Zone sensible — Réinitialiser le compte</span>
      </CardTitle>
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Supprime définitivement les données métier de <strong>{summary.companyName}</strong> :
          clients, fournisseurs, produits, factures et devis, employés, opérations bancaires et
          écritures comptables ({total} élément{total > 1 ? "s" : ""} au total).
          Le dossier, son plan de comptes, ses journaux, ses exercices, son profil, ses membres
          et son abonnement sont conservés.
        </p>
        {total > 0 ? (
          <ul className="grid grid-cols-1 gap-1 text-sm text-slate-500 sm:grid-cols-2">
            {COUNT_LABELS.map(([key, label]) => (
              <li key={key} className="flex justify-between gap-2 border-b border-slate-100 py-1 dark:border-slate-800">
                <span className="capitalize">{label}</span>
                <span className="font-mono text-xs">{summary.counts[key]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">Ce dossier ne contient actuellement aucune donnée métier.</p>
        )}
        {!done ? (
          <>
            <Field label={`Pour confirmer, saisissez le nom exact du dossier (« ${summary.companyName} »)`}>
              <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={summary.companyName} autoComplete="off" />
            </Field>
            {msg ? (<Alert tone={isError ? "danger" : "success"}>{msg}</Alert>) : null}
            <div className="flex justify-end border-t border-slate-100 pt-4">
              <Button disabled={busy || !matches || total === 0} onClick={() => void reset()}>
                Réinitialiser définitivement
              </Button>
            </div>
          </>
        ) : (
          <Alert tone="success">{msg}</Alert>
        )}
      </div>
    </Card>
  );
}
