"use client";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { apiClient, ApiError, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input, Select } from "@/components/ui/Field";
import type { Dunning, DunningChannel, PaymentLink, SalesDocument } from "./types";
import { DUNNING_CHANNELS } from "./types";

type Action = "issue" | "convert" | "creditNote" | "cancel" | "accept" | "refuse" | "dunning" | "paymentLink";

/**
 * Actions d'un document de vente : émettre (numérotation, écriture, certification
 * si le pack l'exige), convertir un devis, créer un avoir, annuler, marquer un
 * devis accepté/refusé, enregistrer une relance, créer un lien de paiement.
 * Chaque action est confirmée ; la page est rafraîchie après succès.
 */
export function SalesDocumentActions({ doc, certifiedSystem, suggestedDunningLevel }: { doc: SalesDocument; certifiedSystem: string | null; suggestedDunningLevel?: number }) {
  const t = useT();
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; certification?: boolean } | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [date, setDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [level, setLevel] = useState(suggestedDunningLevel ?? 1);
  const [channel, setChannel] = useState<DunningChannel>("WHATSAPP");
  const [message, setMessage] = useState("");
  const [provider, setProvider] = useState("mock");

  const isQuote = doc.kind === "QUOTE";
  const isInvoice = doc.kind === "INVOICE";
  const draft = doc.status === "DRAFT";
  const open = doc.status === "SENT" || doc.status === "PARTIALLY_PAID";

  const run = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "issue") {
        const d = await apiClient<SalesDocument>(`/sales/${doc.id}/issue`, { method: "POST" });
        setNotice(t("invoicing.actions.issued", { number: d.number ?? "?" }));
      } else if (action === "convert") {
        const d = await apiClient<SalesDocument>(`/sales/${doc.id}/convert`, { method: "POST", body: { issueDate: date, ...(dueDate ? { dueDate } : {}) } });
        setAction(null);
        router.push(`/invoices/${d.id}`);
        router.refresh();
        return;
      } else if (action === "creditNote") {
        const d = await apiClient<SalesDocument>(`/sales/${doc.id}/credit-note`, { method: "POST", body: { issueDate: date, ...(message.trim() ? { notes: message.trim() } : {}) } });
        setAction(null);
        router.push(`/invoices/${d.id}`);
        router.refresh();
        return;
      } else if (action === "cancel") {
        await apiClient<SalesDocument>(`/sales/${doc.id}/cancel`, { method: "POST" });
        setNotice(t("invoicing.actions.cancelled"));
      } else if (action === "accept" || action === "refuse") {
        await apiClient<SalesDocument>(`/sales/${doc.id}/status`, { method: "POST", body: { status: action === "accept" ? "ACCEPTED" : "REFUSED" } });
        setNotice(t(action === "accept" ? "invoicing.actions.accepted" : "invoicing.actions.refused"));
      } else if (action === "dunning") {
        const d = await apiClient<Dunning>(`/sales/${doc.id}/dunning`, { method: "POST", body: { level, channel, ...(message.trim() ? { message: message.trim() } : {}) } });
        setNotice(t("invoicing.actions.dunningRecorded", { level: d.level, channel: t(`invoicing.channel.${d.channel}`) }));
      } else if (action === "paymentLink") {
        const link = await apiClient<PaymentLink>(`/sales/${doc.id}/payment-link`, { method: "POST", body: { provider: provider.trim() || "mock" } });
        setNotice(
          <>
            {t("invoicing.actions.linkCreated")}{" "}
            <a href={link.url} target="_blank" rel="noreferrer" className="break-all underline">
              {link.url}
            </a>
          </>,
        );
      }
      setAction(null);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.code === "CERTIFICATION_REQUIRED" || e.code === "CERTIFICATION_FAILED")) {
        setError({ text: `${t(e.code === "CERTIFICATION_REQUIRED" ? "invoicing.actions.certificationRequired" : "invoicing.actions.certificationFailed", { system: certifiedSystem ?? "?" })} — ${e.message}`, certification: true });
      } else setError({ text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Action, string> = {
    issue: t("invoicing.actions.issue"),
    convert: t("invoicing.actions.convert"),
    creditNote: t("invoicing.actions.creditNote"),
    cancel: t("invoicing.actions.cancel"),
    accept: t("invoicing.actions.accept"),
    refuse: t("invoicing.actions.refuse"),
    dunning: t("invoicing.actions.dunning"),
    paymentLink: t("invoicing.actions.paymentLink"),
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {draft ? <Button onClick={() => setAction("issue")}>{titles.issue}</Button> : null}
        {isQuote && (doc.status === "SENT" || doc.status === "ACCEPTED") ? <Button onClick={() => setAction("convert")}>{titles.convert}</Button> : null}
        {isQuote && doc.status === "SENT" ? (
          <>
            <Button variant="secondary" onClick={() => setAction("accept")}>{titles.accept}</Button>
            <Button variant="secondary" onClick={() => setAction("refuse")}>{titles.refuse}</Button>
          </>
        ) : null}
        {isInvoice && (open || doc.status === "PAID") ? <Button variant="secondary" onClick={() => setAction("creditNote")}>{titles.creditNote}</Button> : null}
        {isInvoice && open ? (
          <>
            <Button variant="secondary" onClick={() => setAction("dunning")}>{titles.dunning}</Button>
            <Button variant="secondary" onClick={() => setAction("paymentLink")}>{titles.paymentLink}</Button>
          </>
        ) : null}
        {doc.status !== "CANCELLED" && doc.status !== "PAID" && doc.status !== "PARTIALLY_PAID" ? <Button variant="danger" onClick={() => setAction("cancel")}>{titles.cancel}</Button> : null}
      </div>
      {certifiedSystem && draft && isInvoice ? <p className="text-xs text-slate-500">{t("invoicing.actions.certificationHint", { system: certifiedSystem })}</p> : null}
      {error ? <Alert tone={error.certification ? "warning" : "danger"}>{error.text}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <ConfirmDialog
        open={action !== null}
        title={action ? titles[action] : ""}
        confirmVariant={action === "cancel" || action === "refuse" ? "danger" : "primary"}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => {
          if (!busy) setAction(null);
        }}
      >
        {action === "issue" ? <p>{t("invoicing.actions.issueConfirm")}</p> : null}
        {action === "cancel" ? <p>{t("invoicing.actions.cancelConfirm")}</p> : null}
        {action === "accept" ? <p>{t("invoicing.actions.acceptConfirm")}</p> : null}
        {action === "refuse" ? <p>{t("invoicing.actions.refuseConfirm")}</p> : null}
        {action === "convert" ? (
          <div className="space-y-2">
            <p>{t("invoicing.actions.convertConfirm")}</p>
            <Field label={t("invoicing.form.issueDate")}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={`${t("invoicing.form.dueDate")} (${t("common.optional")})`}>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {action === "creditNote" ? (
          <div className="space-y-2">
            <p>{t("invoicing.actions.creditNoteConfirm")}</p>
            <Field label={t("invoicing.form.issueDate")}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={`${t("invoicing.form.notes")} (${t("common.optional")})`}>
              <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} />
            </Field>
          </div>
        ) : null}
        {action === "dunning" ? (
          <div className="space-y-2">
            <p>{t("invoicing.actions.dunningConfirm")}</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("invoicing.dunning.level")}>
                <Select value={String(level)} onChange={(e) => setLevel(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {t("invoicing.dunning.levelN", { n })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("invoicing.dunning.channel")}>
                <Select value={channel} onChange={(e) => setChannel(e.target.value as DunningChannel)}>
                  {DUNNING_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {t(`invoicing.channel.${c}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={`${t("invoicing.dunning.message")} (${t("common.optional")})`}>
              <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} />
            </Field>
          </div>
        ) : null}
        {action === "paymentLink" ? (
          <div className="space-y-2">
            <p>{t("invoicing.actions.paymentLinkConfirm")}</p>
            <Field label={t("invoicing.actions.provider")}>
              <Input value={provider} onChange={(e) => setProvider(e.target.value)} maxLength={40} />
            </Field>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
