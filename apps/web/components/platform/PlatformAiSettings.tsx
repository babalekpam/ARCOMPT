"use client";

import Link from "next/link";
import { useState } from "react";
import { usePlatformAi } from "@/hooks/use-platform-ai";
import { AI_PROVIDERS, type AiDraft, type AiProvider } from "@/lib/platform-ai";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input, Select } from "@/components/ui/Field";

const names: Record<AiProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini" };
const routes: { field: keyof Omit<AiDraft, "models">; label: string; hint: string }[] = [
  { field: "defaultProvider", label: "Fournisseur par défaut", hint: "Fournisseur général utilisé par les appels IA existants." },
  { field: "captureProvider", label: "Capture des documents", hint: "Lecture et extraction des informations des pièces." },
  { field: "categorizeProvider", label: "Catégorisation comptable", hint: "Propositions de classement et d’imputation." },
];
type Confirmation = { action: "test" | "remove"; provider: AiProvider } | { action: "reset" | "reload" };

export function PlatformAiSettings() {
  const ai = usePlatformAi();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  async function confirm() {
    if (!confirmation) return;
    const current = confirmation;
    setConfirmation(null);
    if (current.action === "test") await ai.test(current.provider);
    else if (current.action === "remove") await ai.remove(current.provider);
    else if (current.action === "reset") await ai.reset();
    else await ai.reload();
  }
  const reload = () => {
    if (ai.dirty) setConfirmation({ action: "reload" });
    else void ai.reload();
  };
  return (
    <div className="max-w-5xl space-y-5">
      <Alert tone="warning">
        <strong>Portée plateforme.</strong> Ces paramètres s’appliquent aux appels IA existants de traitement documentaire et de comptabilité, pour toutes les organisations. Les modèles saisis sont utilisés explicitement, sans remplacement silencieux.
      </Alert>
      {ai.error && <Alert tone="danger">
        {ai.error.message}
        {ai.error.kind === "auth"
          ? <Link href="/account/security" className="mt-2 block font-semibold underline">Vérifier la sécurité de mon compte</Link>
          : <Button variant="ghost" className="mt-2" disabled={ai.busy || ai.loading} onClick={reload}>{ai.error.kind === "conflict" ? "Recharger la version actuelle" : "Réessayer le chargement"}</Button>}
      </Alert>}
      {ai.notice && <Alert tone={ai.notice.ok ? "success" : "danger"}>{ai.notice.message}</Alert>}
      {ai.loading ? <div role="status" aria-label="Chargement de la configuration IA" className="space-y-4">
        <span className="sr-only">Chargement de la configuration IA… Les identifiants sont en lecture seule.</span>
        <div className="h-44 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
        <div className="h-64 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
      </div> : ai.settings && ai.draft ? <>
        {!ai.settings.encryptionAvailable && <Alert tone="danger">Le chiffrement des paramètres est indisponible. Cette configuration est en lecture seule ; les clés ne peuvent pas être saisies et aucune modification ni aucun test ne peut être envoyé.<Button variant="ghost" className="mt-2" onClick={reload}>Vérifier à nouveau la disponibilité</Button></Alert>}
        <form onSubmit={(event) => { event.preventDefault(); if (!ai.blocked) void ai.save(); }} autoComplete="off">
          <fieldset disabled={ai.blocked} className="min-w-0 space-y-5">
            <Card>
              <CardTitle hint={`Configuration actuelle · révision ${ai.settings.revision}`}>Affectation des fournisseurs</CardTitle>
              <div className="space-y-4">
                {routes.map(({ field, label, hint }) => <div key={field} className="grid gap-2 border-t border-slate-100 pt-4 first:border-0 first:pt-0 md:grid-cols-[1fr_15rem] dark:border-slate-800">
                  <div><h3 className="text-sm font-medium">{label}</h3><p id={`${field}-hint`} className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p></div>
                  <Select aria-label={label} aria-describedby={`${field}-hint`} value={ai.draft![field]} onChange={(event) => ai.setDraft((draft) => draft && ({ ...draft, [field]: event.target.value as AiProvider }))}>
                    {AI_PROVIDERS.map((id) => <option key={id} value={id}>{names[id]}</option>)}
                  </Select>
                </div>)}
              </div>
            </Card>
            <section aria-labelledby="ai-providers-heading" className="space-y-3">
              <div><h2 id="ai-providers-heading" className="font-semibold">Modèles et identifiants</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Une clé vide conserve la clé actuelle. Les nouvelles clés restent uniquement en mémoire et sont effacées après chaque enregistrement ou test, même en cas d’échec.</p></div>
              {AI_PROVIDERS.map((id, index) => {
                const provider = ai.settings!.providers.find((item) => item.id === id);
                const configured = provider?.configured ?? false;
                const source = provider?.source ?? "none";
                const model = ai.draft!.models[id];
                return <Card key={id}>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-3 font-semibold"><span aria-hidden className="font-mono text-xs text-slate-400">0{index + 1}</span>{names[id]}</h3>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${configured ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}>
                      {configured ? "Clé configurée" : "Clé non configurée"} · {source === "stored" ? "stockage chiffré" : source === "environment" ? "environnement" : "aucune source"}
                    </span>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label={`Modèle ${names[id]}`} hint="Nom exact envoyé au fournisseur. Aucun modèle de secours implicite.">
                      <Input required value={model} onChange={(event) => ai.setDraft((draft) => draft && ({ ...draft, models: { ...draft.models, [id]: event.target.value } }))} spellCheck={false} autoCapitalize="none" />
                    </Field>
                    <Field label={`Nouvelle clé ${names[id]}`} hint="Facultative · laissez vide pour ne rien changer. La clé actuelle n’est jamais affichée.">
                      <Input type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={ai.keys[id]} onChange={(event) => ai.setKeys((keys) => ({ ...keys, [id]: event.target.value }))} placeholder="Saisir une nouvelle clé" />
                    </Field>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <Button variant="secondary" size="sm" disabled={!model.trim() || (!configured && !ai.keys[id])} onClick={() => setConfirmation({ action: "test", provider: id })}>Tester {names[id]}</Button>
                    <Button variant="ghost" size="sm" disabled={source !== "stored"} onClick={() => setConfirmation({ action: "remove", provider: id })}>Supprimer la clé stockée</Button>
                    {source === "environment" && <p className="text-xs text-slate-500 dark:text-slate-400">La clé d’environnement ne peut pas être supprimée ici.</p>}
                  </div>
                </Card>;
              })}
            </section>
            <Alert tone="info">Chaque test déclenche un petit appel réel, potentiellement facturé par le fournisseur. Il utilise le modèle saisi et la nouvelle clé si renseignée, sinon la clé stockée ou d’environnement. Aucune donnée financière n’est envoyée par le test. Un test n’enregistre pas vos modifications.</Alert>
            <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-[#F7F5F0] p-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">{ai.busy ? "Opération en cours…" : ai.dirty ? "Modifications non enregistrées" : "Configuration à jour"}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={reload}>Recharger</Button>
                <Button type="submit" disabled={!ai.dirty || AI_PROVIDERS.some((id) => !ai.draft!.models[id].trim())}>{ai.busy ? "Veuillez patienter…" : "Enregistrer pour la plateforme"}</Button>
              </div>
            </div>
            <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
              <h2 className="text-sm font-semibold">Revenir à la configuration d’environnement</h2>
              <p className="mb-3 mt-1 text-xs text-slate-500 dark:text-slate-400">Supprime toutes les substitutions stockées : clés, modèles et affectations. Les clés d’environnement restent intactes. Une configuration d’environnement invalide entraîne un refus, sans réinitialisation.</p>
              <Button variant="ghost" className="text-red-700 dark:text-red-300" onClick={() => setConfirmation({ action: "reset" })}>Réinitialiser les paramètres stockés</Button>
            </div>
          </fieldset>
        </form>
      </> : !ai.error && <Alert tone="warning">Aucune configuration disponible. <Button variant="ghost" onClick={reload}>Recharger</Button></Alert>}
      <ConfirmDialog open={confirmation !== null} title={confirmation?.action === "test" ? `Tester ${names[confirmation.provider]}` : confirmation?.action === "remove" ? "Supprimer la clé stockée ?" : confirmation?.action === "reset" ? "Réinitialiser toute la configuration ?" : "Recharger la configuration ?"} confirmLabel={confirmation?.action === "test" ? "Lancer l’appel facturable" : confirmation?.action === "reload" ? "Recharger" : "Confirmer la suppression"} confirmVariant={confirmation?.action === "remove" || confirmation?.action === "reset" ? "danger" : "primary"} busy={ai.busy} onCancel={() => setConfirmation(null)} onConfirm={() => void confirm()}>
        {confirmation?.action === "test" ? "Un petit appel réel sera envoyé au fournisseur avec le modèle et la clé saisis, ou la clé configurée si le champ est vide. Il peut être facturé. Aucune donnée financière n’est envoyée. Les clés saisies seront effacées ensuite, sans être enregistrées."
          : confirmation?.action === "remove" ? "Seule la clé stockée de ce fournisseur sera supprimée. Une éventuelle clé d’environnement reste configurée. La suppression est refusée si un fournisseur sélectionné se retrouve sans clé. Les modifications non enregistrées seront abandonnées après succès."
            : confirmation?.action === "reset" ? "Toutes les substitutions stockées seront supprimées pour toutes les organisations. Les clés d’environnement restent intactes. Le serveur refuse l’opération si la configuration d’environnement est invalide. Les modifications non enregistrées seront abandonnées après succès."
              : "La version actuelle du serveur remplacera vos modifications non enregistrées. Les clés saisies seront effacées."}
      </ConfirmDialog>
    </div>
  );
}
