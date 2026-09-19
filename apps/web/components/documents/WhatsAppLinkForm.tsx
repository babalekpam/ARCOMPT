"use client";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";

interface LinkResult {
  conversationId: string;
  phone: string;
  verified: boolean;
}

/** Lier / revérifier un numéro WhatsApp pour le dossier courant (POST /v1/whatsapp/link, /verify). */
export function WhatsAppLinkForm() {
  const t = useT();
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<"link" | "verify" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const digits = phone.replace(/[^0-9]/g, "");
  const valid = /^\d{8,15}$/.test(digits);

  const run = async (action: "link" | "verify") => {
    setBusy(action);
    setNotice(null);
    try {
      const r = await apiClient<LinkResult>(`/whatsapp/${action}`, { method: "POST", body: { phone: digits } });
      setNotice({ tone: "success", text: action === "link" ? t("documents.whatsapp.linked", { phone: r.phone }) : t("documents.whatsapp.verified", { phone: r.phone }) });
    } catch (e) {
      setNotice({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void run("link");
      }}
    >
      <Field label={t("documents.whatsapp.phone")} hint={t("documents.whatsapp.phoneHint")}>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+225 07 00 00 00 00" inputMode="tel" autoComplete="tel" className="font-mono" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!valid || busy !== null}>{busy === "link" ? t("common.loading") : t("documents.whatsapp.link")}</Button>
        <Button variant="secondary" onClick={() => void run("verify")} disabled={!valid || busy !== null}>{busy === "verify" ? t("common.loading") : t("documents.whatsapp.verify")}</Button>
      </div>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
    </form>
  );
}
