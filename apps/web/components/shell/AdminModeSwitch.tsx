"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { resetOfflineServices } from "@/lib/offline-browser";
import { adminModeLabel, ADMIN_MFA_CONTINUATION, type AdminModeStatus } from "@/lib/admin-mode-ui";

/** UI state never grants access; the API validates the opaque server cookie. */
export function AdminModeSwitch({ prominent = false, recoveryPending = false }: { prominent?: boolean; recoveryPending?: boolean }) {
  const [mode, setMode] = useState<AdminModeStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!mode?.active || !mode.expiresAt) return;
    const delay = Date.parse(mode.expiresAt) - Date.now();
    const timer = setTimeout(() => {
      setMode((current) => current ? { ...current, active: false, canReturn: true } : null);
    }, Math.max(0, Math.min(delay, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [mode?.active, mode?.expiresAt]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch("/api/session/admin-mode", { cache: "no-store" });
        if (!response.ok) throw new Error("État du mode administrateur indisponible.");
        const data = await response.json() as AdminModeStatus;
        if (!stopped) { setMode(data); setError(""); }
      } catch {
        if (!stopped) setError("État du mode administrateur indisponible.");
      }
    };
    void load();
    const otherTab = (event: StorageEvent) => {
      if (event.key === "arcompt-mode-change" && event.newValue) {
        // Cookies are shared across tabs: never leave another tab displaying
        // customer controls while its requests would use administrator mode.
        window.location.assign(event.newValue.startsWith("activate:") ? "/platform" : "/dashboard");
      }
    };
    window.addEventListener("storage", otherTab);
    const timer = setInterval(() => { void load(); }, 30000);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("storage", otherTab); };
  }, [retry]);
  async function change(action: "activate" | "deactivate") {
    if (recoveryPending) return;
    setBusy(true); setError("");
    try {
      // Purge old dynamic browser data before activating a new privilege mode.
      // A local cache failure must not leave a newly activated cookie behind.
      resetOfflineServices();
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("arcompt-api-") || key.startsWith("arcompt-pages-")).map((key) => caches.delete(key)));
      }
      const response = await fetch("/api/session/admin-mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await response.json();
      if (!response.ok) {
        if (data.error?.code === "MFA_REQUIRED") {
           window.location.assign(ADMIN_MFA_CONTINUATION);
          return;
        }
        throw new Error(data.error?.message ?? "Changement de mode impossible.");
      }
      // Hard navigation drops React/query/router caches from the previous mode.
      try { localStorage.setItem("arcompt-mode-change", `${action}:${Date.now()}`); } catch { /* Navigation below still resets this tab. */ }
      window.location.assign(action === "activate" ? "/platform" : "/dashboard");
    } catch (e) { setError(e instanceof Error ? e.message : "Changement de mode impossible."); setBusy(false); }
  }
   if (!mode) return <section aria-label="Mode d’accès" className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm dark:border-slate-700 dark:bg-slate-900">
     {error ? <><p role="alert" className="text-red-700 dark:text-red-300">{error}</p><button type="button" onClick={() => { setError(""); setRetry((n) => n + 1); }} className="mt-2 font-semibold underline">Réessayer</button></> : <p role="status" className="animate-pulse text-slate-600 dark:text-slate-300">Vérification de l’accès administrateur…</p>}
   </section>;
   if (!mode.eligible && !mode.canReturn && !mode.active && !prominent) return null;
  const returning = mode.active || mode.canReturn;
  return (
     <section aria-label="Mode d’accès" className={`flex flex-wrap items-center justify-between gap-3 border px-4 py-4 text-sm ${prominent ? "rounded-xl" : "border-x-0"} ${mode.active ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100" : "border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"}`}>
       <div className="min-w-0 flex-1">
         <p role="status" className="font-semibold">{error ? "État administrateur non confirmé" : adminModeLabel(mode)}</p>
         <p className="mt-1 text-xs leading-relaxed opacity-90">{mode.active ? "Accès aux dossiers journalisé. Votre compte utilisateur reste inchangé." : mode.canReturn ? "Revenez à votre compte, puis réactivez le mode si vous êtes autorisé." : mode.approvedPending ? "L’approbation n’est pas un accès actif. Une vérification MFA récente reste obligatoire." : mode.eligible ? "Activez explicitement le mode avec une vérification MFA récente, puis ouvrez la vue d’ensemble." : "Cette page sécurise votre connexion. La MFA seule ne donne aucun droit administrateur."}</p>
       </div>
       {mode.active && !recoveryPending && !error && <Link href="/platform" className="rounded-lg bg-brand px-3 py-2 font-semibold text-slate-50 dark:bg-amber-100 dark:text-amber-950">Vue d’ensemble admin</Link>}
       {mode.active && !recoveryPending && !error && <Link href="/platform/ai" className="rounded-lg border border-current px-3 py-2 font-semibold">Fournisseurs IA</Link>}
       {(returning || mode.eligible) && <button type="button" disabled={busy || recoveryPending} onClick={() => void change(returning ? "deactivate" : "activate")} className="rounded-lg border border-current px-3 py-2 font-semibold disabled:opacity-50">
        {busy ? "Veuillez patienter…" : returning ? "Revenir à mon compte" : "Passer en super-admin"}
       </button>}
       {recoveryPending && <p className="w-full text-xs">Sauvegardez les codes de secours ci-dessous avant de changer de mode.</p>}
       {error ? <p role="alert" className="w-full text-red-700 dark:text-red-300">{error}</p> : null}
    </section>
  );
}