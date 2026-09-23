// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import type { MessageChannel, MissingDocumentRequest } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Demander une pièce manquante au client, par WhatsApp ou e-mail (POST /portal/missing-documents). */
export function MissingDocForm() {
  const t = useT();
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [channel, setChannel] = useState<MessageChannel>("WHATSAPP");
  const [recipient, setRecipient] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [entryId, setEntryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MissingDocumentRequest | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((partnerId && !UUID_RE.test(partnerId.trim())) || (entryId && !UUID_RE.test(entryId.trim()))) return setError(t("firm.requests.invalidId"));
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient<MissingDocumentRequest>("/portal/missing-documents", {
        method: "POST",
        body: {
          description: description.trim(),
          channel,
          ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
          ...(partnerId.trim() ? { partnerId: partnerId.trim() } : {}),
          ...(entryId.trim() ? { entryId: entryId.trim() } : {}),
        },
      });
      setDone(r);
      setDescription("");
      setRecipient("");
      setPartnerId("");
      setEntryId("");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <Field label={t("firm.requests.description")}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={2000} placeholder={t("firm.requests.descriptionHint")} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("firm.requests.channel")}>
          <Select value={channel} onChange={(e) => setChannel(e.target.value as MessageChannel)}>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="EMAIL">{t("firm.requests.email")}</option>
          </Select>
        </Field>
        <Field label={`${t("firm.requests.recipient")} (${t("common.optional")})`} hint={t("firm.requests.recipientHint")}>
          <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={200} placeholder={channel === "WHATSAPP" ? "+225…" : "client@exemple.ci"} />
        </Field>
        <Field label={`${t("firm.requests.partner")} (${t("common.optional")})`}>
          <Input value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className="font-mono text-xs" placeholder="uuid" />
        </Field>
        <Field label={`${t("firm.requests.entry")} (${t("common.optional")})`}>
          <Input value={entryId} onChange={(e) => setEntryId(e.target.value)} className="font-mono text-xs" placeholder="uuid" />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? <Alert tone="success">{done.sentAt ? t("firm.requests.sent", { to: done.recipient }) : t("firm.requests.createdNotSent", { to: done.recipient })}</Alert> : null}
      <Button type="submit" disabled={busy || !description.trim()}>{busy ? t("common.loading") : t("firm.requests.send")}</Button>
    </form>
  );
}

/** Marquer une demande comme satisfaite en indiquant la pièce reçue (POST /portal/missing-documents/:id/received). */
export function MarkReceivedForm({ requestId }: { requestId: string }) {
  const t = useT();
  const router = useRouter();
  const [documentId, setDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = UUID_RE.test(documentId.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient<MissingDocumentRequest>(`/portal/missing-documents/${requestId}/received`, { method: "POST", body: { documentId: documentId.trim() } });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-center gap-2">
      <Input value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder={t("firm.requests.documentId")} aria-label={t("firm.requests.documentId")} className="w-64 font-mono text-xs" />
      <Button type="submit" size="sm" variant="secondary" disabled={busy || !valid}>{busy ? t("common.loading") : t("firm.requests.markReceived")}</Button>
      {error ? <span className="basis-full text-xs text-red-600">{error}</span> : null}
    </form>
  );
}
