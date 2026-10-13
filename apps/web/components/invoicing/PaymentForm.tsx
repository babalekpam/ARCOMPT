// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-client";
import { compareAmounts, normalizeInput } from "@/lib/money";
import type { TreasuryAccount } from "@/components/treasury/types";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { PartnerPicker } from "./PartnerPicker";
import { sumAllocations } from "./totals";
import type { AllocationInput, Partner, Payment, PaymentInput, PaymentKind, PaymentMethod, PurchaseDocument, SalesDocument } from "./types";
import { PAYMENT_METHODS } from "./types";

interface OpenDoc {
  id: string;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  outstanding: string;
  currency: string;
}

const DEFAULT_ACCOUNT: Record<PaymentMethod, string> = { BANK: "521", CHEQUE: "521", CASH: "571", MOBILE_MONEY: "5381" };

/**
 * Enregistrement d'un règlement : encaissement (client) ou décaissement
 * (fournisseur / salarié), méthode, compte de trésorerie, tiers, montant et
 * affectations aux documents ouverts du tiers. Au-delà du seuil du dossier,
 * l'API met le règlement en attente d'approbation par un autre utilisateur.
 */
export function PaymentForm({ currency, initialKind = "RECEIPT", initialPartnerId, initialDocumentId }: { currency: string; initialKind?: PaymentKind; initialPartnerId?: string; initialDocumentId?: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [kind, setKind] = useState<PaymentKind>(initialKind);
  const [method, setMethod] = useState<PaymentMethod>("BANK");
  const [accounts, setAccounts] = useState<TreasuryAccount[] | null>(null);
  const [treasury, setTreasury] = useState("");
  const [partner, setPartner] = useState<Partner | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [openDocs, setOpenDocs] = useState<OpenDoc[] | null>(null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Payment | null>(null);

  const preselectDone = useRef(false);
  useEffect(() => {
    if (preselectDone.current || !initialPartnerId) return;
    preselectDone.current = true;
    apiClient<Partner>(`/partners/${initialPartnerId}`)
      .then((p) => setPartner(p))
      .catch(() => {});
  }, [initialPartnerId]);

  useEffect(() => {
    apiClient<TreasuryAccount[]>("/treasury/accounts")
      .then((a) => setAccounts(a))
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    setOpenDocs(null);
    setAlloc({});
    if (!partner) return;
    const load = kind === "RECEIPT" ? apiClient<SalesDocument[]>("/sales", { query: { partnerId: partner.id, kind: "INVOICE", limit: 200 } }) : apiClient<PurchaseDocument[]>("/purchases", { query: { partnerId: partner.id, limit: 200 } });
    load
      .then((docs) => {
        const mapped = (docs as Array<SalesDocument | PurchaseDocument>).filter((d) => (kind === "RECEIPT" ? d.status === "SENT" || d.status === "PARTIALLY_PAID" : (d.status === "POSTED" || d.status === "PARTIALLY_PAID") && d.kind !== "SUPPLIER_CREDIT_NOTE")).map((d) => ({ id: d.id, number: d.number, issueDate: d.issueDate, dueDate: d.dueDate, outstanding: d.outstanding, currency: d.currency }));
        setOpenDocs(mapped);
        if (initialDocumentId) {
          const target = mapped.find((d) => d.id === initialDocumentId);
          if (target) {
            setAlloc({ [target.id]: target.outstanding });
            setAmount((prev) => (prev ? prev : target.outstanding));
          }
        }
      })
      .catch(() => setOpenDocs([]));
  }, [partner, kind, initialDocumentId]);

  const allocated = useMemo(() => sumAllocations(Object.values(alloc)), [alloc]);
  const amountNorm = normalizeInput(amount);
  const overAllocated = allocated !== null && amountNorm !== null && compareAmounts(allocated, amountNorm) > 0;
  const treasuryOptions = (accounts ?? []).filter((a) => a.active && (method === "CASH" ? a.kind === "CASH" : method === "MOBILE_MONEY" ? a.kind === "MOBILE_MONEY" : a.kind === "BANK"));

  const fillRemaining = () => {
    if (!amountNorm || !openDocs) return;
    let remaining = amountNorm;
    const next: Record<string, string> = {};
    for (const d of openDocs) {
      if (compareAmounts(remaining, "0") <= 0) break;
      const take = compareAmounts(d.outstanding, remaining) <= 0 ? d.outstanding : remaining;
      next[d.id] = take;
      remaining = sumAllocations([remaining, `-${take}`]) ?? "0";
    }
    setAlloc(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!partner) return setError(t("invoicing.form.errorPartner"));
    if (!amountNorm) return setError(t("invoicing.payments.errorAmount"));
    if (allocated === null) return setError(t("invoicing.payments.errorAllocation"));
    if (overAllocated) return setError(t("invoicing.payments.errorOverAllocated"));
    const allocations: AllocationInput[] = [];
    for (const [docId, v] of Object.entries(alloc)) {
      const n = normalizeInput(v);
      if (!n) continue;
      allocations.push(kind === "RECEIPT" ? { salesDocumentId: docId, amount: n } : { purchaseDocumentId: docId, amount: n });
    }
    const body: PaymentInput = { kind, method, partnerId: partner.id, amount: amountNorm, date, ...(treasury ? { treasuryAccountNumber: treasury } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}), ...(allocations.length > 0 ? { allocations } : {}) };
    setBusy(true);
    try {
      const p = await apiClient<Payment>("/payments", { method: "POST", body });
      setResult(p);
      setAmount("");
      setReference("");
      setAlloc({});
      setPartner(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("invoicing.payments.kind")}>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as PaymentKind);
              setPartner(null);
            }}
          >
            <option value="RECEIPT">{t("invoicing.paymentKind.RECEIPT")}</option>
            <option value="DISBURSEMENT">{t("invoicing.paymentKind.DISBURSEMENT")}</option>
          </Select>
        </Field>
        <Field label={t("invoicing.payments.method")}>
          <Select
            value={method}
            onChange={(e) => {
              setMethod(e.target.value as PaymentMethod);
              setTreasury("");
            }}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`invoicing.method.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("invoicing.payments.treasuryAccount")} hint={t("invoicing.payments.treasuryHint", { account: DEFAULT_ACCOUNT[method] })}>
          {treasuryOptions.length > 0 ? (
            <Select value={treasury} onChange={(e) => setTreasury(e.target.value)}>
              <option value="">{t("invoicing.payments.treasuryDefault", { account: DEFAULT_ACCOUNT[method] })}</option>
              {treasuryOptions.map((a) => (
                <option key={a.id} value={a.accountNumber}>
                  {a.accountNumber} — {a.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input value={treasury} onChange={(e) => setTreasury(e.target.value.trim())} placeholder={DEFAULT_ACCOUNT[method]} inputMode="numeric" className="font-mono" />
          )}
        </Field>
        <Field label={t("common.date")}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label={kind === "RECEIPT" ? t("invoicing.form.customer") : t("invoicing.expense.partner")} className="sm:col-span-2">
          <PartnerPicker types={kind === "RECEIPT" ? ["CUSTOMER"] : ["SUPPLIER", "EMPLOYEE"]} value={partner} onChange={setPartner} />
        </Field>
        <Field label={`${t("common.amount")} (${currency})`}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="text-right font-mono" required />
        </Field>
        <Field label={`${t("common.reference")} (${t("common.optional")})`}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t("invoicing.payments.allocations")}</legend>
        {!partner ? <p className="text-sm text-slate-500">{t("invoicing.payments.pickPartnerFirst")}</p> : null}
        {partner && openDocs === null ? <p className="text-xs text-slate-500">{t("common.loading")}</p> : null}
        {partner && openDocs && openDocs.length === 0 ? <p className="text-sm text-slate-500">{t("invoicing.payments.noOpenDocuments")}</p> : null}
        {openDocs && openDocs.length > 0 ? (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-1 pr-3">{t("invoicing.number")}</th>
                  <th className="py-1 pr-3">{t("invoicing.form.dueDate")}</th>
                  <th className="py-1 pr-3 text-right">{t("invoicing.outstanding")}</th>
                  <th className="py-1 text-right">{t("invoicing.payments.allocate")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {openDocs.map((d) => (
                  <tr key={d.id}>
                    <td className="py-1 pr-3 font-mono text-xs">{d.number ?? "—"}</td>
                    <td className="py-1 pr-3 text-xs">{formatDate(locale, d.dueDate ?? d.issueDate)}</td>
                    <td className="py-1 pr-3 text-right"><Money value={d.outstanding} currency={d.currency} /></td>
                    <td className="py-1 text-right">
                      <Input value={alloc[d.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} inputMode="decimal" className="ml-auto w-32 text-right font-mono" aria-label={t("invoicing.payments.allocate")} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <Button variant="secondary" size="sm" onClick={fillRemaining} disabled={!amountNorm}>
                {t("invoicing.payments.autoAllocate")}
              </Button>
              <span className={overAllocated ? "text-red-600" : "text-slate-600 dark:text-slate-300"}>
                {t("invoicing.payments.allocated")} <Money value={allocated ?? "0"} currency={currency} className="font-semibold" /> / <Money value={amountNorm ?? "0"} currency={currency} />
              </span>
            </div>
          </>
        ) : null}
      </fieldset>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <Alert tone={result.status === "RECORDED" ? "success" : "warning"}>
          {result.status === "RECORDED" ? t("invoicing.payments.recorded", { number: result.number }) : t("invoicing.payments.pending", { number: result.number })}
        </Alert>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? t("common.loading") : t("invoicing.payments.submit")}
      </Button>
    </form>
  );
}
