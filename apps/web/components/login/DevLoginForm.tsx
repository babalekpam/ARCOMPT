// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Formulaire de connexion dev : user id, dossier (UUID), organisation (UUID facultatif). */
export function DevLoginForm() {
  const t = useT();
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!userId.trim() || !tenantId.trim()) return setError(t("login.required"));
    if (!UUID_RE.test(tenantId.trim())) return setError(t("login.invalidTenant"));
    setBusy(true);
    try {
      const res = await fetch("/api/session/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: userId.trim(), tenantId: tenantId.trim(), organizationId: organizationId.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(t("login.error", { message: body?.error?.message ?? res.statusText }));
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <Field label={t("login.userId")}>
        <Input value={userId} onChange={(e) => setUserId(e.target.value)} autoComplete="username" required />
      </Field>
      <Field label={t("login.tenantId")}>
        <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="00000000-0000-4000-8000-000000000000" className="font-mono text-xs" required />
      </Field>
      <Field label={`${t("login.organizationId")} (${t("common.optional")})`}>
        <Input value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} className="font-mono text-xs" />
      </Field>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? t("common.loading") : t("login.submit")}
      </Button>
    </form>
  );
}
