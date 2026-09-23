// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { Organization } from "./types";

/** Bascule « MFA obligatoire » (PUT /portal/org/mfa, propriétaire uniquement ; l'API refuse sinon). */
export function MfaToggle({ organization, canEdit }: { organization: Organization; canEdit: boolean }) {
  const t = useT();
  const router = useRouter();
  const [required, setRequired] = useState(organization.mfaRequired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = organization.kind === "FIRM";
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const org = await apiClient<Organization>("/portal/org/mfa", { method: "PUT", body: { required: !required } });
      setRequired(org.mfaRequired);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={required ? "success" : "warning"}>{required ? t("firm.org.mfaOn") : t("firm.org.mfaOff")}</Badge>
      {canEdit && !locked ? (
        <Button size="sm" variant="secondary" onClick={() => void toggle()} disabled={busy} aria-pressed={required}>
          {busy ? t("common.loading") : required ? t("firm.org.mfaDisable") : t("firm.org.mfaEnable")}
        </Button>
      ) : null}
      {locked ? <span className="text-xs text-slate-500">{t("firm.org.mfaFirm")}</span> : null}
      {error ? <span className="basis-full text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
