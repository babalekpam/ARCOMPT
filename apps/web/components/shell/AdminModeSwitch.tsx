"use client";
import { useEffect, useState } from "react";
import { resetOfflineServices } from "@/lib/offline-browser";

interface Mode { eligible: boolean; active: boolean; expiresAt: string | null; canReturn?: boolean }
/** UI state never grants access; the API validates the opaque server cookie. */
export function AdminModeSwitch() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch("/api/session/admin-mode", { cache: "no-store" });
        if (!response.ok) throw new Error("État du mode administrateur indisponible.");
        const data = await response.json() as Mode;
        if (!stopped) setMode(data);
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
  }, []);
  async function change(action: "activate" | "deactivate") {
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
          window.location.assign("/account/security");
          return;
        }
        throw new Error(data.error?.message ?? "Changement de mode impossible.");
      }
      // Hard navigation drops React/query/router caches from the previous mode.
      try { localStorage.setItem("arcompt-mode-change", `${action}:${Date.now()}`); } catch { /* Navigation below still resets this tab. */ }
      window.location.assign(action === "activate" ? "/platform" : "/dashboard");
    } catch (e) { setError(e instanceof Error ? e.message : "Changement de mode impossible."); setBusy(false); }
  }
  if (!mode) return error ? <p role="status" className="px-4 py-2 text-sm text-red-700">{error}</p> : null;
  if (!mode.eligible && !mode.canReturn) return null;
  const returning = mode.active || mode.canReturn;
  return (
    <section aria-label="Mode d’accès" className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-sm ${mode.active ? "border-amber-300 bg-amber-100 text-amber-950" : "border-slate-200 bg-slate-50 text-slate-900"}`}>
      <p>{mode.active ? "Mode super-admin — accès aux dossiers journalisé." : returning ? "Mode super-admin expiré ou révoqué. Revenez à votre compte." : "Vous utilisez votre compte utilisateur."}</p>
      <button type="button" disabled={busy} onClick={() => void change(returning ? "deactivate" : "activate")} className="rounded border border-current px-3 py-1.5 font-semibold disabled:opacity-50">
        {busy ? "Veuillez patienter…" : returning ? "Revenir à mon compte" : "Passer en super-admin"}
      </button>
      {error ? <p role="alert" className="w-full text-red-700">{error}</p> : null}
    </section>
  );
}