"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-client";
import { generateClientId } from "@/lib/offline";
import { normalizeInput } from "@/lib/money";
import type { PurchaseDocument, SalesDocument } from "@/components/invoicing/types";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { barScale, flowsFromDocuments, weeksBelow } from "./forecast";
import type { Forecast, ForecastBody, RecurringItemInput, TreasuryAccount } from "./types";

interface RecurringState extends RecurringItemInput {
  key: string;
}

const newRecurring = (): RecurringState => ({ key: generateClientId(), label: "", amount: "", direction: "OUT", frequency: "MONTHLY", dayOfMonth: 1 });

/**
 * Prévision de trésorerie à 13 semaines : solde d'ouverture (comptes choisis ou
 * saisi), factures ouvertes (clients et fournisseurs) chargées depuis la
 * facturation, flux récurrents (loyer, paie, TVA…), seuil d'alerte. Tableau
 * hebdomadaire et barres CSS (sans bibliothèque graphique).
 */
export function ForecastView({ accounts, currency }: { accounts: TreasuryAccount[]; currency: string }) {
  const { t, locale } = useI18n();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [weeks, setWeeks] = useState("13");
  const [useAccounts, setUseAccounts] = useState(accounts.length > 0);
  const [selected, setSelected] = useState<string[]>(accounts.filter((a) => a.active).map((a) => a.id));
  const [openingBalance, setOpeningBalance] = useState("");
  const [minimumBalance, setMinimumBalance] = useState("");
  const [includeInvoices, setIncludeInvoices] = useState(true);
  const [recurring, setRecurring] = useState<RecurringState[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [openWeek, setOpenWeek] = useState<number | null>(null);
  const [docs, setDocs] = useState<{ sales: SalesDocument[]; purchases: PurchaseDocument[] } | null>(null);

  useEffect(() => {
    Promise.all([apiClient<SalesDocument[]>("/sales", { query: { kind: "INVOICE", limit: 500 } }), apiClient<PurchaseDocument[]>("/purchases", { query: { limit: 500 } })])
      .then(([sales, purchases]) => setDocs({ sales, purchases }))
      .catch(() => setDocs({ sales: [], purchases: [] }));
  }, []);

  const receivables = useMemo(() => (docs ? flowsFromDocuments(docs.sales, ["SENT", "PARTIALLY_PAID"]) : []), [docs]);
  const payables = useMemo(() => (docs ? flowsFromDocuments(docs.purchases.filter((d) => d.kind !== "SUPPLIER_CREDIT_NOTE"), ["POSTED", "PARTIALLY_PAID"]) : []), [docs]);

  const updateRec = (key: string, patch: Partial<RecurringState>) => setRecurring((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const rec: RecurringItemInput[] = [];
    for (const r of recurring) {
      const amount = normalizeInput(r.amount);
      if (!r.label.trim() || !amount) return setError(t("treasury.forecast.errorRecurring"));
      rec.push({ label: r.label.trim(), amount, direction: r.direction, frequency: r.frequency, ...(r.frequency === "MONTHLY" ? { dayOfMonth: r.dayOfMonth ?? 1 } : { weekday: r.weekday ?? 1 }) });
    }
    const body: ForecastBody = {
      asOf,
      weeks: Math.min(52, Math.max(1, Number(weeks) || 13)),
      ...(useAccounts && selected.length > 0 ? { accountIds: selected } : {}),
      ...(!useAccounts && openingBalance.trim() ? { openingBalance: openingBalance.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", ".") } : {}),
      ...(minimumBalance.trim() ? { minimumBalance: minimumBalance.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", ".") } : {}),
      ...(includeInvoices ? { receivables, payables } : {}),
      ...(rec.length > 0 ? { recurring: rec } : {}),
    };
    setBusy(true);
    try {
      setForecast(await apiClient<Forecast>("/treasury/forecast", { method: "POST", body }));
      setOpenWeek(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const scale = useMemo(() => (forecast ? barScale(forecast.weeks) : null), [forecast]);
  const below = useMemo(() => (forecast ? weeksBelow(forecast.weeks, minimumBalance) : []), [forecast, minimumBalance]);

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t("treasury.forecast.asOf")}>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
          </Field>
          <Field label={t("treasury.forecast.weeks")}>
            <Input value={weeks} onChange={(e) => setWeeks(e.target.value)} inputMode="numeric" className="font-mono" />
          </Field>
          <Field label={`${t("treasury.forecast.minimum")} (${currency})`}>
            <Input value={minimumBalance} onChange={(e) => setMinimumBalance(e.target.value)} inputMode="decimal" className="text-right font-mono" placeholder="0" />
          </Field>
          <Field label={t("treasury.forecast.openingSource")}>
            <Select value={useAccounts ? "accounts" : "manual"} onChange={(e) => setUseAccounts(e.target.value === "accounts")}>
              <option value="accounts">{t("treasury.forecast.fromAccounts")}</option>
              <option value="manual">{t("treasury.forecast.manualOpening")}</option>
            </Select>
          </Field>
          {useAccounts ? (
            <div className="col-span-2 flex flex-wrap gap-2 sm:col-span-4">
              {accounts.map((a) => (
                <label key={a.id} className="flex items-center gap-1 rounded-full border border-slate-300 px-2 py-1 text-xs dark:border-slate-700">
                  <input type="checkbox" checked={selected.includes(a.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
                  {a.label} <span className="font-mono text-slate-500">{a.accountNumber}</span>
                </label>
              ))}
              {accounts.length === 0 ? <span className="text-xs text-slate-500">{t("treasury.forecast.noAccounts")}</span> : null}
            </div>
          ) : (
            <Field label={`${t("treasury.forecast.opening")} (${currency})`} className="col-span-2">
              <Input value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} inputMode="decimal" className="text-right font-mono" />
            </Field>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeInvoices} onChange={(e) => setIncludeInvoices(e.target.checked)} />
          {t("treasury.forecast.includeInvoices", { receivables: receivables.length, payables: payables.length })}
          {docs === null ? <span className="text-xs text-slate-500">({t("common.loading")})</span> : null}
        </label>

        <fieldset>
          <legend className="mb-2 text-sm font-semibold">{t("treasury.forecast.recurring")}</legend>
          <div className="space-y-2">
            {recurring.map((r) => (
              <div key={r.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
                <Input value={r.label} onChange={(e) => updateRec(r.key, { label: e.target.value })} placeholder={t("common.label")} aria-label={t("common.label")} maxLength={120} className="col-span-2 sm:col-span-1" />
                <Input value={r.amount} onChange={(e) => updateRec(r.key, { amount: e.target.value })} placeholder={t("common.amount")} aria-label={t("common.amount")} inputMode="decimal" className="text-right font-mono" />
                <Select value={r.direction} onChange={(e) => updateRec(r.key, { direction: e.target.value as "IN" | "OUT" })} aria-label={t("treasury.forecast.direction")}>
                  <option value="IN">{t("treasury.forecast.in")}</option>
                  <option value="OUT">{t("treasury.forecast.out")}</option>
                </Select>
                <Select value={r.frequency} onChange={(e) => updateRec(r.key, { frequency: e.target.value as "WEEKLY" | "MONTHLY" })} aria-label={t("treasury.forecast.frequency")}>
                  <option value="MONTHLY">{t("treasury.forecast.monthly")}</option>
                  <option value="WEEKLY">{t("treasury.forecast.weekly")}</option>
                </Select>
                {r.frequency === "MONTHLY" ? (
                  <Input type="number" min={1} max={31} value={r.dayOfMonth ?? 1} onChange={(e) => updateRec(r.key, { dayOfMonth: Number(e.target.value) })} aria-label={t("treasury.forecast.dayOfMonth")} className="font-mono" />
                ) : (
                  <Select value={String(r.weekday ?? 1)} onChange={(e) => updateRec(r.key, { weekday: Number(e.target.value) })} aria-label={t("treasury.forecast.weekday")}>
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <option key={d} value={d}>
                        {t(`treasury.forecast.day.${d}`)}
                      </option>
                    ))}
                  </Select>
                )}
                <Button variant="ghost" size="sm" onClick={() => setRecurring((rs) => rs.filter((x) => x.key !== r.key))} aria-label={t("treasury.forecast.remove")}>
                  ✕
                </Button>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => setRecurring((rs) => [...rs, newRecurring()])}>
            + {t("treasury.forecast.addRecurring")}
          </Button>
        </fieldset>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? t("common.loading") : t("treasury.forecast.compute")}
        </Button>
      </form>

      {forecast && scale ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              {t("treasury.forecast.lowest")} <Money value={forecast.lowestBalance} currency={currency} colorSign className="font-semibold" /> ({t("treasury.forecast.weekN", { n: forecast.lowestWeek + 1 })})
            </span>
            {forecast.firstWeekBelowMinimum !== null ? <span className="text-red-700 dark:text-red-300">{t("treasury.forecast.belowMinimum", { n: forecast.firstWeekBelowMinimum + 1 })}</span> : <span className="text-emerald-700 dark:text-emerald-300">{t("treasury.forecast.aboveMinimum")}</span>}
            {forecast.beyondHorizon.inflows !== "0.0000" || forecast.beyondHorizon.outflows !== "0.0000" ? (
              <span className="text-xs text-slate-500">
                {t("treasury.forecast.beyond")} +<Money value={forecast.beyondHorizon.inflows} currency={currency} /> / −<Money value={forecast.beyondHorizon.outflows} currency={currency} />
              </span>
            ) : null}
          </div>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("treasury.forecast.week")}</th>
                  <th className="py-2 pr-3 text-right">{t("treasury.forecast.opening")}</th>
                  <th className="py-2 pr-3 text-right">{t("treasury.forecast.inflows")}</th>
                  <th className="py-2 pr-3 text-right">{t("treasury.forecast.outflows")}</th>
                  <th className="py-2 pr-3 text-right">{t("treasury.forecast.closing")}</th>
                  <th className="py-2 w-[30%]">{t("treasury.forecast.chart")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {forecast.weeks.map((w) => {
                  const low = below.includes(w.index);
                  return (
                    <tr key={w.index} className={low ? "bg-red-50 dark:bg-red-950/30" : ""}>
                      <td className="py-1.5 pr-3">
                        <button type="button" onClick={() => setOpenWeek(openWeek === w.index ? null : w.index)} className="text-left underline-offset-2 hover:underline">
                          <span className="font-medium">{t("treasury.forecast.weekN", { n: w.index + 1 })}</span>
                          <span className="block text-xs text-slate-500">
                            {formatDate(locale, w.from)} → {formatDate(locale, w.to)}
                          </span>
                        </button>
                        {openWeek === w.index ? (
                          <ul className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                            {w.items.length === 0 ? <li>{t("treasury.forecast.noItems")}</li> : null}
                            {w.items.map((it, i) => (
                              <li key={i} className="flex justify-between gap-2">
                                <span className="truncate">
                                  {formatDate(locale, it.date)} · {it.label}
                                  {it.overdue ? ` (${t("treasury.forecast.overdue")})` : ""}
                                </span>
                                <Money value={it.amount} currency={currency} colorSign />
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-3 text-right align-top"><Money value={w.opening} currency={currency} colorSign /></td>
                      <td className="py-1.5 pr-3 text-right align-top text-emerald-700 dark:text-emerald-300"><Money value={w.inflows} currency={currency} dashForZero /></td>
                      <td className="py-1.5 pr-3 text-right align-top text-red-700 dark:text-red-300"><Money value={w.outflows} currency={currency} dashForZero /></td>
                      <td className={`py-1.5 pr-3 text-right align-top font-semibold ${low ? "text-red-700 dark:text-red-300" : ""}`}><Money value={w.closing} currency={currency} colorSign /></td>
                      <td className="py-1.5 align-top">
                        <div className="space-y-0.5" aria-hidden>
                          <div className="h-1.5 rounded bg-emerald-500/80" style={{ width: `${scale.widthOf(w.inflows)}%` }} />
                          <div className="h-1.5 rounded bg-red-500/80" style={{ width: `${scale.widthOf(w.outflows)}%` }} />
                          <div className={`h-1.5 rounded ${w.closing.startsWith("-") ? "bg-red-800" : "bg-slate-700 dark:bg-slate-300"}`} style={{ width: `${scale.widthOf(w.closing)}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">{t("treasury.forecast.legend")}</p>
        </div>
      ) : null}
    </div>
  );
}
