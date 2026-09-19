"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
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
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient<AcceptResult>("/portal/org/invitations/accept", {
        method: "POST",
        body: { token: token.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) },
      });
      setResult(r);
      setToken("");
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={`${t("firm.invitations.email")} (${t("common.optional")})`}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={`${t("firm.members.displayName")} (${t("common.optional")})`}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? <Alert tone="success">{t("firm.invitations.accepted", { role: t(`firm.role.${result.role}`), n: result.companyIds.length })}</Alert> : null}
      <Button type="submit" variant="secondary" disabled={busy || token.trim().length < 16}>{busy ? t("common.loading") : t("firm.invitations.accept")}</Button>
    </form>
  );
}
