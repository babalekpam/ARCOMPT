"use client";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiClient, ApiError, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { generateClientId } from "@/lib/offline";
import { createOrQueue } from "@/lib/offline-submit";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { PartnerPicker } from "./PartnerPicker";
import { previewTotals } from "./totals";
import type { PackVatRate, Partner, Product, SalesDocument, SalesDocumentInput, SalesKind, SalesLineInput } from "./types";

interface LineState {
  key: string;
  productId: string;
  label: string;
  quantity: string;
  unitPrice: string;
  accountNumber: string;
  vatCode: string; // "" = code du produit / aucun ; "__none" = hors champ (null)
}

const NONE = "__none";
const newLine = (): LineState => ({ key: generateClientId(), productId: "", label: "", quantity: "1", unitPrice: "", accountNumber: "", vatCode: "" });

/**
 * Formulaire devis / facture : tiers, produits du catalogue, lignes dynamiques
 * et aperçu HT / TVA / TTC calculé avec les taux du pack pays. Enregistre un
 * brouillon (POST /v1/sales) ; l'émission se fait depuis la fiche du document.
 * Avec `existing`, met à jour le brouillon (PUT /v1/sales/:id).
 */
export function SalesDocumentForm({ rates, currency, initialKind = "INVOICE", existing, packDraft = null }: { rates: PackVatRate[]; currency: string; initialKind?: SalesKind; existing?: SalesDocument; packDraft?: string | null }) {
  const t = useT();
  const router = useRouter();
  const [kind, setKind] = useState<SalesKind>(existing?.kind ?? initialKind);
  const [partner, setPartner] = useState<Partner | null>(existing ? { id: existing.partnerId, name: existing.partnerName, type: "CUSTOMER", taxId: null, collectiveAccount: "411", contact: {}, active: true, createdAt: "" } : null);
  const [issueDate, setIssueDate] = useState(existing?.issueDate ?? new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((l) => ({ key: generateClientId(), productId: l.productId ?? "", label: l.label, quantity: l.quantity, unitPrice: l.unitPrice, accountNumber: l.accountNumber, vatCode: l.vatCode ?? NONE }))
      : [newLine()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient<Product[]>("/products")
      .then((p) => setProducts(p))
      .catch(() => setProducts([]));
  }, []);

  const productOf = (id: string) => products?.find((p) => p.id === id);

  const preview = useMemo(
    () =>
      previewTotals(
        lines.map((l) => {
          const p = products?.find((x) => x.id === l.productId);
          const code = l.vatCode === NONE ? null : l.vatCode || p?.vatCode || null;
          return { quantity: l.quantity, unitPrice: l.unitPrice.trim() !== "" ? l.unitPrice : (p?.unitPrice ?? ""), vatCode: code };
        }),
        { rates, currency, date: issueDate },
      ),
    [lines, products, rates, currency, issueDate],
  );

  const update = (key: string, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));
  const pickProduct = (key: string, id: string) => {
    const p = productOf(id);
    update(key, { productId: id, ...(p ? { label: p.label, unitPrice: p.unitPrice, accountNumber: p.defaultAccountNumber, vatCode: p.vatCode ?? NONE } : {}) });
  };

  const build = (): SalesDocumentInput | string => {
    if (!partner) return t("invoicing.form.errorPartner");
    if (!preview.valid) return t("invoicing.form.errorLines");
    const out: SalesLineInput[] = [];
    for (const l of lines) {
      const p = productOf(l.productId);
      if (!p && !l.label.trim()) return t("invoicing.form.errorLines");
      if (!p && !/^[1-9]\d{1,12}$/.test(l.accountNumber.trim())) return t("invoicing.form.errorAccount");
      const line: SalesLineInput = {};
      if (p) line.productId = p.id;
      if (l.label.trim()) line.label = l.label.trim();
      if (l.quantity.trim()) line.quantity = l.quantity.trim().replace(",", ".");
      if (l.unitPrice.trim()) line.unitPrice = l.unitPrice.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
      if (l.accountNumber.trim()) line.accountNumber = l.accountNumber.trim();
      if (l.vatCode === NONE) line.vatCode = null;
      else if (l.vatCode) line.vatCode = l.vatCode;
      out.push(line);
    }
    return { kind, partnerId: partner.id, issueDate, ...(dueDate ? { dueDate } : {}), currency, ...(notes.trim() ? { notes: notes.trim() } : {}), lines: out };
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const input = build();
    if (typeof input === "string") return setError(input);
    setBusy(true);
    try {
      // Modification : elle vise un document qui existe déjà côté serveur, donc
      // elle ne se met pas en file — il n'y aurait rien à modifier hors ligne.
      if (existing) {
        const doc = await apiClient<SalesDocument>(`/sales/${existing.id}`, { method: "PUT", body: { ...input, kind: undefined } });
        router.push(`/invoices/${doc.id}`);
        router.refresh();
        return;
      }
      const outcome = await createOrQueue("sales.draft", input as unknown as Record<string, unknown>, (body) =>
        apiClient<SalesDocument>("/sales", { method: "POST", body }),
      );
      if (outcome.queued) {
        // Le brouillon est chiffré sur l'appareil ; il partira au retour du
        // réseau. On emmène l'utilisateur là où il peut le voir.
        router.push("/sync");
      } else {
        router.push(`/invoices/${outcome.result.id}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "VALIDATION" ? `${t("invoicing.form.errorValidation")} ${errorMessage(err)}` : errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("invoicing.form.kind")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as SalesKind)} disabled={Boolean(existing)}>
            <option value="QUOTE">{t("invoicing.kind.QUOTE")}</option>
            <option value="INVOICE">{t("invoicing.kind.INVOICE")}</option>
          </Select>
        </Field>
        <Field label={t("invoicing.form.issueDate")}>
          <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        </Field>
        <Field label={`${t("invoicing.form.dueDate")} (${t("common.optional")})`}>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label={t("common.currency")}>
          <Input value={currency} readOnly className="bg-slate-50 dark:bg-slate-800/50" />
        </Field>
        <Field label={t("invoicing.form.customer")} className="sm:col-span-4">
          <PartnerPicker types={["CUSTOMER"]} value={partner} onChange={setPartner} />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t("invoicing.form.lines")}</legend>
        {rates.length === 0 ? <Alert tone="warning" className="mb-2">{t("invoicing.form.noRates")}</Alert> : null}
        {/* Les taux proposés ci-dessous viennent du pack : on le dit là où on les
            choisit, en une ligne, sans transformer la facturation en avertissement. */}
        {packDraft && rates.length > 0 ? <p className="mb-2 text-xs text-slate-500">{t("invoicing.form.packDraft", { pack: packDraft })}</p> : null}
        <div className="space-y-2">
          <div className="hidden grid-cols-[1.2fr_1.6fr_5rem_1fr_6rem_7rem_1fr_auto] gap-2 text-xs uppercase tracking-wide text-slate-500 lg:grid">
            <span>{t("invoicing.form.product")}</span>
            <span>{t("common.label")}</span>
            <span className="text-right">{t("invoicing.form.quantity")}</span>
            <span className="text-right">{t("invoicing.form.unitPrice")}</span>
            <span>{t("common.account")}</span>
            <span>{t("invoicing.form.vat")}</span>
            <span className="text-right">{t("invoicing.form.gross")}</span>
            <span />
          </div>
          {lines.map((l, i) => {
            const pl = preview.lines[i];
            return (
              <div key={l.key} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-2 lg:grid-cols-[1.2fr_1.6fr_5rem_1fr_6rem_7rem_1fr_auto] lg:border-0 lg:p-0 dark:border-slate-800">
                <Select value={l.productId} onChange={(e) => pickProduct(l.key, e.target.value)} aria-label={t("invoicing.form.product")} className="col-span-2 lg:col-span-1">
                  <option value="">{products === null ? t("common.loading") : t("invoicing.form.freeLine")}</option>
                  {(products ?? []).filter((p) => p.active || p.id === l.productId).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} — {p.label}
                    </option>
                  ))}
                </Select>
                <Input value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} placeholder={t("common.label")} aria-label={t("common.label")} className="col-span-2 lg:col-span-1" maxLength={300} />
                <Input value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} inputMode="decimal" aria-label={t("invoicing.form.quantity")} className="text-right font-mono" />
                <Input value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} placeholder={productOf(l.productId)?.unitPrice ?? "0"} inputMode="decimal" aria-label={t("invoicing.form.unitPrice")} className="text-right font-mono" />
                <Input value={l.accountNumber} onChange={(e) => update(l.key, { accountNumber: e.target.value.trim() })} placeholder={productOf(l.productId)?.defaultAccountNumber ?? "701"} inputMode="numeric" aria-label={t("common.account")} className="font-mono" />
                <Select value={l.vatCode} onChange={(e) => update(l.key, { vatCode: e.target.value })} aria-label={t("invoicing.form.vat")}>
                  <option value="">{productOf(l.productId)?.vatCode ? `${t("invoicing.form.vatProduct")} (${productOf(l.productId)?.vatCode})` : t("invoicing.form.vatNone")}</option>
                  <option value={NONE}>{t("invoicing.form.vatNone")}</option>
                  {rates.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.code} · {String(r.rate)}
                    </option>
                  ))}
                </Select>
                <div className="self-center text-right text-sm">
                  <Money value={pl?.gross ?? "0"} currency={currency} />
                  {pl?.unknownVatCode ? <span className="ml-1 text-xs text-red-600">{t("invoicing.form.vatUnknown")}</span> : null}
                </div>
                <Button variant="ghost" size="sm" onClick={() => remove(l.key)} disabled={lines.length <= 1} aria-label={t("invoicing.form.removeLine")}>
                  ✕
                </Button>
              </div>
            );
          })}
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
                <dt className="text-slate-500">{t("invoicing.form.vat")} {r.vatCode} ({r.rate})</dt>
                <dd className="text-right"><Money value={r.vat} currency={currency} /></dd>
              </Fragment>
            ))}
            <dt className="text-slate-500">{t("invoicing.form.vatTotal")}</dt>
            <dd className="text-right"><Money value={preview.totalVat} currency={currency} /></dd>
            <dt className="font-semibold">{t("invoicing.form.gross")}</dt>
            <dd className="text-right font-semibold"><Money value={preview.totalGross} currency={currency} showCurrency /></dd>
          </dl>
        </div>
      </fieldset>

      <Field label={`${t("invoicing.form.notes")} (${t("common.optional")})`}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} rows={3} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-950" />
      </Field>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !preview.valid}>
          {busy ? t("common.loading") : existing ? t("common.save") : t("invoicing.form.saveDraft")}
        </Button>
        <p className="self-center text-xs text-slate-500">{t("invoicing.form.issueHint")}</p>
      </div>
    </form>
  );
}
