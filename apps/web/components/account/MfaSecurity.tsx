"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { isAdminActivationContinuation } from "@/lib/admin-mode-ui";

type Status = { enabled: boolean; verified: boolean; expiresAt?: string };
type Enrollment = { secret: string; otpauthUri: string; expiresAt: string };
type Action = "enroll" | "confirm" | "verify" | "recovery-codes";

async function request(action?: Action, code?: string): Promise<Record<string, unknown>> {
  const res = await fetch("/api/session/mfa", {
    method: action ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(action ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, code }) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data.error as { code?: string; message?: string } | undefined;
    const label = error?.code === "UNAUTHORIZED" ? "Session expirée : reconnectez-vous."
      : error?.code === "MFA_CONFIG" ? "La sécurité MFA n’est pas configurée sur le serveur. Contactez l’administration."
      : error?.code === "MFA_REQUIRED" ? "Vérification expirée : saisissez un nouveau code."
      : res.status === 429 ? "Trop de tentatives. Patientez avant de réessayer."
      : res.status === 400 || res.status === 409 ? "Code incorrect, déjà utilisé ou demande expirée. Vérifiez l'heure de votre appareil et réessayez."
      : error?.message || `Service indisponible (${res.status}). Réessayez.`;
    throw new Error(label);
  }
  return data as Record<string, unknown>;
}

function codesFrom(data: Record<string, unknown>): string[] {
  return Array.isArray(data.recoveryCodes) ? data.recoveryCodes.filter((code): code is string => typeof code === "string") : [];
}

export function MfaSecurity({ onRecoveryCodesChange }: { onRecoveryCodesChange?: (pending: boolean) => void }) {
  const { signOut } = useClerk();
  const [status, setStatus] = useState<Status | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [rotationCode, setRotationCode] = useState("");
  const [usingRecovery, setUsingRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adminContinuation, setAdminContinuation] = useState(false);
  const recoveryCallback = useRef(onRecoveryCodesChange);
  recoveryCallback.current = onRecoveryCodesChange;
  useEffect(() => { recoveryCallback.current?.(recoveryCodes.length > 0); }, [recoveryCodes.length]);
  useEffect(() => {
    setAdminContinuation(isAdminActivationContinuation(window.location.pathname, window.location.search));
  }, []);

  const refresh = useCallback(async () => {
    const data = await request();
    setStatus({ enabled: data.enabled === true, verified: data.verified === true, expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined });
  }, []);

  useEffect(() => { refresh().catch((e: Error) => setError(e.message)); }, [refresh]);
  useEffect(() => {
    if (!status?.verified || !status.expiresAt) return;
    const delay = Date.parse(status.expiresAt) - Date.now();
    const timer = setTimeout(() => {
      setStatus((current) => current ? { ...current, verified: false } : null);
      setNotice("Vérification expirée. Saisissez un nouveau code pour continuer.");
    }, Math.max(0, Math.min(delay, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [status?.verified, status?.expiresAt]);

  async function run(action: Action, value?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await request(action, value);
      if (action === "enroll") {
        if (typeof data.secret !== "string" || typeof data.otpauthUri !== "string" || !data.otpauthUri.startsWith("otpauth://totp/")) throw new Error("Réponse d’inscription incomplète. Réessayez.");
        setEnrollment({ secret: data.secret, otpauthUri: data.otpauthUri, expiresAt: String(data.expiresAt ?? "") });
        setRecoveryCodes([]);
      } else {
        if (action === "confirm") setEnrollment(null);
        if (action === "confirm" || action === "recovery-codes") {
          setRecoveryCodes(codesFrom(data));
          setNotice(action === "confirm" ? "Authentificateur activé. Enregistrez vos codes de secours maintenant." : "Nouveaux codes créés. Les anciens codes et votre vérification précédente ne sont plus valables. Vérifiez-vous à nouveau.");
          if (action === "recovery-codes") setStatus((current) => current ? { ...current, verified: false, expiresAt: undefined } : null);
        } else {
          setNotice(adminContinuation ? "Vérification réussie. Vous pouvez maintenant activer le mode super-admin en haut de cette page." : "Vérification MFA réussie pour cette session. Les autorisations d’accès restent vérifiées séparément.");
        }
        setCode("");
        setRotationCode("");
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur de sécurité inconnue.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice("Copié dans le presse-papiers."); }
    catch { setError("Copie impossible. Sélectionnez et copiez le texte manuellement."); }
  }

  async function logout() {
    try { await fetch("/api/session/logout", { method: "POST", credentials: "same-origin" }); }
    finally { await signOut({ redirectUrl: "/login" }); }
  }

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 dark:border-slate-700 dark:bg-slate-900">
      <h2 className="text-xl font-semibold">Double authentification</h2>
      {adminContinuation && <p role="status" className="mt-3 rounded-lg bg-sky-50 p-3 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-200">Vérifiez cette session, puis activez le mode super-admin en haut de cette page. Aucune activation automatique : votre compte reste inchangé.</p>}
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">ARCOMPT gère son propre second facteur. Aucun abonnement MFA payant de Clerk n’est nécessaire. Votre connexion Clerk reste inchangée.</p>
      {error && <p role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}
      {notice && <p role="status" className="mt-5 rounded-lg bg-teal-50 p-3 text-sm text-teal-800 dark:bg-teal-950 dark:text-teal-200">{notice}</p>}
      {!status && <button type="button" onClick={() => { setError(""); refresh().catch((e: Error) => setError(e.message)); }} className="mt-5 text-sm text-sky-700 underline">Charger / réessayer</button>}
      {status && <>
        <p className="mt-5 text-sm font-medium">{status.enabled ? "Authentificateur activé" : "Authentificateur non activé"} · {status.verified ? "Session vérifiée" : "Session non vérifiée"}</p>
        {status.verified && status.expiresAt && <p className="mt-1 text-xs text-slate-500">Vérification valable jusqu’au {new Date(status.expiresAt).toLocaleString("fr-FR")}.</p>}
        {!status.enabled && !enrollment && <button type="button" disabled={busy} onClick={() => run("enroll")} className="mt-5 rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Configurer une application d’authentification</button>}
        {enrollment && <div className="mt-6 space-y-3 border-t border-slate-200 pt-5 dark:border-slate-700">
          <h2 className="font-semibold">Configurer l’authentificateur</h2>
          <p className="text-sm">Ajoutez un compte dans votre application d’authentification (TOTP). Ouvrez le lien ci-dessous sur votre appareil ou saisissez la clé manuellement. Ne partagez pas cette clé.</p>
          <div className="flex flex-wrap items-center gap-3"><code className="break-all rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">{enrollment.secret}</code><button type="button" onClick={() => copy(enrollment.secret)} className="text-sm text-sky-700 underline">Copier la clé</button></div>
          <a href={enrollment.otpauthUri} className="inline-block break-all text-sm text-sky-700 underline dark:text-sky-300">Ouvrir dans l’application d’authentification</a>
          {enrollment.expiresAt && <p className="text-xs text-slate-500">Configuration à confirmer avant le {new Date(enrollment.expiresAt).toLocaleString("fr-FR")}.</p>}
          <form onSubmit={(e) => { e.preventDefault(); void run("confirm", code.trim()); }} className="space-y-2">
            <label htmlFor="mfa-confirm" className="block text-sm font-medium">Code à 6 chiffres affiché par l’application</label>
            <input id="mfa-confirm" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="w-full max-w-xs rounded-lg border border-slate-300 bg-transparent px-3 py-2" />
            <button disabled={busy} className="block rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Confirmer l’activation</button>
          </form>
          <button type="button" onClick={() => setEnrollment(null)} className="text-sm text-slate-600 underline">Annuler</button>
        </div>}
        {status.enabled && !status.verified && <div className="mt-6 border-t border-slate-200 pt-5 dark:border-slate-700">
          <h2 className="font-semibold">Vérifier cette session</h2>
          <p className="mt-2 text-sm">Saisissez un nouveau code de votre application, ou utilisez un code de secours à usage unique.</p>
          <form onSubmit={(e) => { e.preventDefault(); void run("verify", code.trim()); }} className="mt-3 space-y-2">
            <label htmlFor="mfa-verify" className="block text-sm font-medium">{usingRecovery ? "Code de secours" : "Code à 6 chiffres"}</label>
            <input id="mfa-verify" required inputMode={usingRecovery ? "text" : "numeric"} pattern={usingRecovery ? undefined : "[0-9]{6}"} maxLength={usingRecovery ? 128 : 6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="w-full max-w-xs rounded-lg border border-slate-300 bg-transparent px-3 py-2" />
            <button disabled={busy} className="block rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Vérifier</button>
          </form>
          <button type="button" onClick={() => { setUsingRecovery(!usingRecovery); setCode(""); }} className="mt-3 text-sm text-sky-700 underline">{usingRecovery ? "Utiliser l’application" : "Utiliser un code de secours"}</button>
        </div>}
        {recoveryCodes.length > 0 && <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:bg-amber-950">
          <h2 className="font-semibold">Codes de secours · affichage unique</h2>
          <p className="mt-2 text-sm">Enregistrez-les maintenant dans un lieu sûr, hors de cet appareil. Chaque code ne sert qu’une fois. Ils ne seront plus affichés après avoir quitté cette page.</p>
          <ul className="mt-3 grid grid-cols-1 gap-2 font-mono text-sm sm:grid-cols-2">{recoveryCodes.map((item) => <li key={item} className="break-all">{item}</li>)}</ul>
          <button type="button" onClick={() => copy(recoveryCodes.join("\n"))} className="mt-3 text-sm text-sky-700 underline">Copier tous les codes</button>
          <button type="button" onClick={() => setRecoveryCodes([])} className="ml-4 text-sm text-slate-600 underline">J’ai sauvegardé mes codes</button>
        </div>}
        {status.enabled && <div className="mt-6 border-t border-slate-200 pt-5 dark:border-slate-700">
          <h2 className="font-semibold">Renouveler les codes de secours</h2>
          <p className="mt-2 text-sm">Un code récent de l’application d’authentification est obligatoire. Tous les anciens codes seront invalidés.</p>
          <form onSubmit={(e) => { e.preventDefault(); void run("recovery-codes", rotationCode.trim()); }} className="mt-3 space-y-2">
            <label htmlFor="mfa-rotate" className="block text-sm font-medium">Nouveau code à 6 chiffres</label>
            <input id="mfa-rotate" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={rotationCode} onChange={(e) => setRotationCode(e.target.value)} className="w-full max-w-xs rounded-lg border border-slate-300 bg-transparent px-3 py-2" />
            <button disabled={busy} className="block rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">Créer de nouveaux codes</button>
          </form>
        </div>}
      </>}
      <div className="mt-8 flex flex-wrap gap-5 border-t border-slate-200 pt-5 text-sm dark:border-slate-700">
        {status?.verified && !recoveryCodes.length && (adminContinuation ? <a href="#admin-mode" className="font-medium text-sky-700 underline dark:text-sky-300">Continuer : activer le mode super-admin</a> : <Link href="/api/session/landing" className="font-medium text-sky-700 underline dark:text-sky-300">Continuer vers ARCOMPT</Link>)}
        {!recoveryCodes.length && <Link href="/account" className="font-medium text-sky-700 underline dark:text-sky-300">Retour au compte</Link>}
        <button type="button" onClick={() => { void logout(); }} className="text-slate-600 underline dark:text-slate-300">Se déconnecter</button>
      </div>
      <p className="mt-4 text-xs text-slate-500">L’activation seule n’accorde aucun rôle administrateur ni accès à un dossier. ARCOMPT vérifie les autorisations séparément.</p>
    </section>
  );
}