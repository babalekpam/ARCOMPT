// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import type { AcceptResult } from "./types";

/** Accepter une invitation avec son jeton (POST /portal/org/invitations/accept), en tant qu'utilisateur connecté. */
export function AcceptInvitationForm() {
  const t = useT();
  const router = useRouter();
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResult | null>(null);

  /**
   * Le courriel d'invitation place le code dans le FRAGMENT de l'adresse
   * (`#token=…`). Un fragment ne part jamais vers un serveur : ni journaux
   * d'accès, ni en-tête Referer vers un tiers. On le lit ici, puis on l'efface
   * de la barre d'adresse pour qu'il ne reste pas dans l'historique partagé
   * d'un poste. Sans fragment, le champ reste vide et se saisit à la main.
   */
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#")) return;
    const fromLink = new URLSearchParams(hash.slice(1)).get("token");
    if (!fromLink) return;
    setToken(fromLink);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient<AcceptResult>("/portal/org/invitations/accept", {
        method: "POST",
        body: { token: token.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) },
      });
      setResult(r);
      setToken("");
      const selected = r.companyIds[0];
      if (!selected) throw new Error("Invitation sans dossier");
      const selection = await fetch("/api/session/tenant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: selected }),
      });
      if (!selection.ok) throw new Error("Invitation acceptée, mais le dossier n'a pas pu être sélectionné");
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <Field label={t("firm.invitations.token")}>
        <Input value={token} onChange={(e) => setToken(e.target.value)} required minLength={16} className="font-mono text-xs" autoComplete="off" />
      </Field>
      <Field label={`${t("firm.members.displayName")} (${t("common.optional")})`}>
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
      </Field>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? <Alert tone="success">{t("firm.invitations.accepted", { role: t(`firm.role.${result.role}`), n: result.companyIds.length })}</Alert> : null}
      <Button type="submit" variant="secondary" disabled={busy || token.trim().length < 16}>{busy ? t("common.loading") : t("firm.invitations.accept")}</Button>
    </form>
  );
}
