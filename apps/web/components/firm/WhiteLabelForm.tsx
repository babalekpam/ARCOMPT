// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import type { WhiteLabelSettings } from "./types";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Marque blanche du cabinet : nom, logo (pièce), couleurs, expéditeur (PUT /portal/org/white-label, propriétaire). */
export function WhiteLabelForm({ settings, canEdit }: { settings: WhiteLabelSettings; canEdit: boolean }) {
  const t = useT();
  const router = useRouter();
  const [brandName, setBrandName] = useState(settings.brandName ?? "");
  const [logoDocumentId, setLogoDocumentId] = useState(settings.logoDocumentId ?? "");
  const [primary, setPrimary] = useState(settings.colours.primary ?? "#0f172a");
  const [accent, setAccent] = useState(settings.colours.accent ?? "#f59e0b");
  const [senderName, setSenderName] = useState(settings.senderName ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (logoDocumentId.trim() && !UUID_RE.test(logoDocumentId.trim())) return setNotice({ tone: "danger", text: t("firm.requests.invalidId") });
    setBusy(true);
    setNotice(null);
    try {
      await apiClient<WhiteLabelSettings>("/portal/org/white-label", {
        method: "PUT",
        body: {
          brandName: brandName.trim() || null,
          logoDocumentId: logoDocumentId.trim() || null,
          colours: { primary: HEX_RE.test(primary) ? primary : null, accent: HEX_RE.test(accent) ? accent : null },
          senderName: senderName.trim() || null,
        },
      });
      setNotice({ tone: "success", text: t("firm.whiteLabel.saved") });
      router.refresh();
    } catch (err) {
      setNotice({ tone: "danger", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("firm.whiteLabel.brandName")}>
          <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={80} disabled={!canEdit} />
        </Field>
        <Field label={t("firm.whiteLabel.senderName")} hint={t("firm.whiteLabel.senderHint")}>
          <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} maxLength={80} disabled={!canEdit} />
        </Field>
        <Field label={t("firm.whiteLabel.logo")} hint={t("firm.whiteLabel.logoHint")} className="sm:col-span-2">
          <Input value={logoDocumentId} onChange={(e) => setLogoDocumentId(e.target.value)} className="font-mono text-xs" placeholder="uuid" disabled={!canEdit} />
        </Field>
        <Field label={t("firm.whiteLabel.primary")}>
          <div className="flex items-center gap-2">
            <input type="color" value={HEX_RE.test(primary) ? primary : "#0f172a"} onChange={(e) => setPrimary(e.target.value)} disabled={!canEdit} className="h-9 w-12 rounded border border-slate-300 dark:border-slate-700" aria-label={t("firm.whiteLabel.primary")} />
            <Input value={primary} onChange={(e) => setPrimary(e.target.value)} maxLength={7} className="font-mono" disabled={!canEdit} />
          </div>
        </Field>
        <Field label={t("firm.whiteLabel.accent")}>
          <div className="flex items-center gap-2">
            <input type="color" value={HEX_RE.test(accent) ? accent : "#f59e0b"} onChange={(e) => setAccent(e.target.value)} disabled={!canEdit} className="h-9 w-12 rounded border border-slate-300 dark:border-slate-700" aria-label={t("firm.whiteLabel.accent")} />
            <Input value={accent} onChange={(e) => setAccent(e.target.value)} maxLength={7} className="font-mono" disabled={!canEdit} />
          </div>
        </Field>
      </div>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {canEdit ? <Button type="submit" disabled={busy}>{busy ? t("common.loading") : t("common.save")}</Button> : <p className="text-xs text-slate-500">{t("firm.ownerOnly")}</p>}
    </form>
  );
}
