"use client";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { generateClientId } from "@/lib/offline";
import { Alert } from "@/components/ui/Alert";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { ExpenseAccountPicker } from "./ExpenseAccountPicker";
import { PartnerPicker } from "./PartnerPicker";
import { previewTotals } from "./totals";
import type { PackVatRate, Partner, PurchaseDocument, PurchaseDocumentInput, PurchaseKind, PurchaseLineInput } from "./types";

interface LineState {
  key: string;
  accountNumber: string;
  label: string;
  net: string;
  vatCode: string; // "" = hors TVA
}

const newLine = (): LineState => ({ key: generateClientId(), accountNumber: "", label: "", net: "", vatCode: "" });

/**
 * Formulaire facture fournisseur / note de frais : tiers (fournisseur ou
 * salarié), référence, lignes avec compte de classe 6/2 et TVA déductible,
 * aperçu HT / TVA / TTC. Enregistre un brouillon (POST /v1/purchases) ou met à
 * jour un brouillon existant (PUT). `documentId` relie une pièce capturée.
 */
export function PurchaseDocumentForm({ rates, currency, initialKind = "SUPPLIER_INVOICE", existing, documentId }: { rates: PackVatRate[]; currency: string; initialKind?: PurchaseKind; existing?: PurchaseDocument; documentId?: string }) {
  const t = useT();
  const router = useRouter();
  const [kind, setKind] = useState<PurchaseKind>(existing?.kind ?? initialKind);
  const [partner, setPartner] = useState<Partner | null>(existing ? { id: existing.partnerId, name: existing.partnerName, type: existing.kind === "EXPENSE_CLAIM" ? "EMPLOYEE" : "SUPPLIER", taxId: null, collectiveAccount: existing.kind === "EXPENSE_CLAIM" ? "421" : "401", contact: {}, active: true, createdAt: "" } : null);
  const [reference, setReference] = useState(existing?.reference ?? "");
  const [issueDate, setIssueDate] = useState(existing?.issueDate ?? new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [lines, setLines] = useState<LineState[]>(existing ? existing.lines.map((l) => ({ key: generateClientId(), accountNumber: l.accountNumber, label: l.label, net: l.net, vatCode: l.vatCode ?? "" })) : [newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => previewTotals(lines.map((l) => ({ net: l.net, vatCode: l.vatCode || null })), { rates, currency, date: issueDate }), [lines, rates, currency, issueDate]);
  const update = (key: string, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));
  const partnerTypes = kind === "EXPENSE_CLAIM" ? (["EMPLOYEE"] as const) : (["SUPPLIER"] as const);

  const build = (): PurchaseDocumentInput | string => {
    if (!partner) return t("invoicing.form.errorPartner");
    if (!preview.valid) return t("invoicing.form.errorLines");
    const out: PurchaseLineInput[] = [];
    for (const l of lines) {
      if (!/^[1-9]\d{1,12}$/.test(l.accountNumber.trim())) return t("invoicing.form.errorAccount");
      if (!l.label.trim() || l.net.trim() === "") return t("invoicing.form.errorLines");
      out.push({ accountNumber: l.accountNumber.trim(), label: l.label.trim(), net: l.net.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", "."), vatCode: l.vatCode || null });
    }
    return {
      kind,
      partnerId: partner.id,
      issueDate,
      currency,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(documentId ? { documentId } : {}),
      lines: out,
    };
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const input = build();
    if (typeof input === "string") return setError(input);
    setBusy(true);
    try {
      const doc = existing ? await apiClient<PurchaseDocument>(`/purchases/${existing.id}`, { method: "PUT", body: { ...input, kind: undefined } }) : await apiClient<PurchaseDocument>("/purchases", { method: "POST", body: input });
      router.push(`/expenses/${doc.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("invoicing.form.kind")}>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as PurchaseKind);
              setPartner(null);
            }}
            disabled={Boolean(existing)}
          >
            <option value="SUPPLIER_INVOICE">{t("invoicing.purchaseKind.SUPPLIER_INVOICE")}</option>
            <option value="EXPENSE_CLAIM">{t("invoicing.purchaseKind.EXPENSE_CLAIM")}</option>
          </Select>
        </Field>
        <Field label={`${t("invoicing.expense.reference")} (${t("common.optional")})`}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
        </Field>
        <Field label={t("invoicing.form.issueDate")}>
          <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        </Field>
        <Field label={`${t("invoicing.form.dueDate")} (${t("common.optional")})`}>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label={kind === "EXPENSE_CLAIM" ? t("invoicing.expense.employee") : t("invoicing.expense.supplier")} className="sm:col-span-4">
          <PartnerPicker types={[...partnerTypes]} value={partner} onChange={setPartner} />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t("invoicing.form.lines")}</legend>
        <div className="space-y-2">
          <div className="hidden grid-cols-[minmax(9rem,1fr)_2fr_1fr_8rem_1fr_auto] gap-2 text-xs uppercase tracking-wide text-slate-500 sm:grid">
            <span>{t("common.account")}</span>
            <span>{t("common.label")}</span>
            <span className="text-right">{t("invoicing.form.net")}</span>
            <span>{t("invoicing.form.vat")}</span>
            <span className="text-right">{t("invoicing.form.gross")}</span>
            <span />
          </div>
          {lines.map((l, i) => (
            <div key={l.key} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-[minmax(9rem,1fr)_2fr_1fr_8rem_1fr_auto] sm:border-0 sm:p-0 dark:border-slate-800">
              <div className="col-span-2 sm:col-span-1">
                <ExpenseAccountPicker value={l.accountNumber} onChange={(n) => update(l.key, { accountNumber: n })} />
              </div>
              <Input value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} placeholder={t("common.label")} aria-label={t("common.label")} className="col-span-2 sm:col-span-1" maxLength={300} />
              <Input value={l.net} onChange={(e) => update(l.key, { net: e.target.value })} placeholder={t("invoicing.form.net")} aria-label={t("invoicing.form.net")} inputMode="decimal" className="text-right font-mono" />
              <Select value={l.vatCode} onChange={(e) => update(l.key, { vatCode: e.target.value })} aria-label={t("invoicing.form.vat")}>
                <option value="">{t("invoicing.form.vatNone")}</option>
                {rates.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.code} · {String(r.rate)}
                  </option>
                ))}
              </Select>
              <div className="self-center text-right text-sm">
                <Money value={preview.lines[i]?.gross ?? "0"} currency={currency} />
              </div>
              <Button variant="ghost" size="sm" onClick={() => remove(l.key)} disabled={lines.length <= 1} aria-label={t("invoicing.form.removeLine")} className="col-span-2 sm:col-span-1">
                ✕
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
            + {t("invoicing.form.addLine")}
          </Button>
          <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm">
            <dt className="text-slate-500">{t("invoicing.form.net")}</dt>
            <dd className="text-right"><Money value={preview.totalNet} currency={currency} /></dd>
            {preview.byVatCode.map((r) => (
              <Fragment key={r.vatCode}>
                <dt className="text-slate-500">{t("invoicing.expense.deductibleVat")} {r.vatCode} ({r.rate})</dt>
                <dd className="text-right"><Money value={r.vat} currency={currency} /></dd>
              </Fragment>
            ))}
            <dt className="font-semibold">{t("invoicing.form.gross")}</dt>
            <dd className="text-right font-semibold"><Money value={preview.totalGross} currency={currency} showCurrency /></dd>
          </dl>
        </div>
      </fieldset>

      <Field label={`${t("invoicing.form.notes")} (${t("common.optional")})`}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} rows={3} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-950" />
      </Field>
      {documentId ? <p className="text-xs text-slate-500">{t("invoicing.expense.linkedDocument")} <span className="font-mono">{documentId}</span></p> : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !preview.valid}>
          {busy ? t("common.loading") : existing ? t("common.save") : t("invoicing.form.saveDraft")}
        </Button>
        <LinkButton href="/documents/upload" variant="secondary">
          {t("invoicing.expense.capture")}
        </LinkButton>
        <p className="text-xs text-slate-500">{t("invoicing.expense.issueHint")}</p>
      </div>
    </form>
  );
}
