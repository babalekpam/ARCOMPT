"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n-client";
import { Button, type ButtonVariant } from "@/components/ui/Button";

/**
 * « Ouvrir » un dossier : mémorise le dossier courant dans le cookie httpOnly
 * (même flux que le sélecteur de dossier, POST /api/session/tenant) puis
 * navigue vers `then` (tableau de bord par défaut).
 */
export function OpenCompanyButton({ companyId, current = false, then = "/", variant = "secondary", label }: { companyId: string; current?: boolean; then?: string; variant?: ButtonVariant; label?: string }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const open = () =>
    start(async () => {
      setError(null);
      const res = await fetch("/api/session/tenant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: companyId }) });
      if (!res.ok) {
        setError(t("common.error"));
        return;
      }
      router.push(then);
      router.refresh();
    });
  return (
    <span className="inline-flex flex-col">
      <Button size="sm" variant={current ? "ghost" : variant} onClick={open} disabled={pending} title={companyId}>
        {pending ? t("common.loading") : (label ?? (current ? t("firm.companies.current") : t("firm.companies.open")))}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
