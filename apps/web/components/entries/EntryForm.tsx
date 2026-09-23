// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiClient, ApiError, errorMessage, NetworkError } from "@/lib/api-client";
import { toRecentEntry } from "@/lib/entries";
import { useT } from "@/lib/i18n-client";
import { addAmounts, compareAmounts, normalizeInput, subAmounts } from "@/lib/money";
import { generateClientId, type EntryDraftInput } from "@/lib/offline";
import { getOfflineServices } from "@/lib/offline-browser";
import { JOURNAL_CODES, type Account, type JournalEntry } from "@/lib/types";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { AccountPicker } from "./AccountPicker";

interface LineState {
  key: string;
  accountNumber: string;
  debit: string;
  credit: string;
  label: string;
}

const newLine = (): LineState => ({ key: generateClientId(), accountNumber: "", debit: "", credit: "", label: "" });

/**
 * Formulaire de saisie d'écriture : lignes dynamiques, sélecteur de compte,
 * contrôle d'équilibre côté client. Le corps envoyé ne contient jamais
 * d'identifiant de dossier (le proxy ajoute les en-têtes). Hors ligne, le
 * brouillon est chiffré et mis en file (jamais de validation hors ligne).
 */
export function EntryForm({ currency }: { currency: string }) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[] | null | undefined>(undefined);
  const [journalCode, setJournalCode] = useState<string>("OD");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [label, setLabel] = useState("");
  const [lines, setLines] = useState<LineState[]>([newLine(), newLine()]);
  const [clientId, setClientId] = useState(generateClientId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ text: string; id?: string } | null>(null);

  useEffect(() => {
    apiClient<{ accounts: Account[] }>("/accounts")
      .then((d) => setAccounts(d.accounts.length > 0 ? d.accounts : null))
      .catch(() => setAccounts(null));
  }, []);

  const totals = useMemo(() => {
    let debit = "0";
    let credit = "0";
    for (const l of lines) {
      const d = normalizeInput(l.debit);
      const c = normalizeInput(l.credit);
      if (d) debit = addAmounts(debit, d);
      if (c) credit = addAmounts(credit, c);
    }
    return { debit, credit, diff: subAmounts(debit, credit), balanced: compareAmounts(debit, credit) === 0 && debit !== "0.0000" };
  }, [lines]);

  const update = (key: string, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => setLines((ls) => (ls.length > 2 ? ls.filter((l) => l.key !== key) : ls));

  const buildInput = (): EntryDraftInput | string => {
    if (!label.trim()) return t("entries.form.errorLabel");
    const out: EntryDraftInput["lines"] = [];
    for (const l of lines) {
      const d = normalizeInput(l.debit);
      const c = normalizeInput(l.credit);
      if (!/^[1-9]\d{1,12}$/.test(l.accountNumber) || (!d && !c) || (d && c)) return t("entries.form.errorLines");
      out.push({ accountNumber: l.accountNumber, ...(d ? { debit: d } : {}), ...(c ? { credit: c } : {}), ...(l.label.trim() ? { label: l.label.trim() } : {}) });
    }
    if (!totals.balanced) return t("entries.form.errorBalanced");
    return { journalCode, date, ...(reference.trim() ? { reference: reference.trim() } : {}), label: label.trim(), source: "MANUAL", lines: out };
  };

  const reset = () => {
    setLabel("");
    setReference("");
    setLines([newLine(), newLine()]);
    setClientId(generateClientId());
  };

  const submit = async (e: FormEvent, validate: boolean) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const input = buildInput();
    if (typeof input === "string") return setError(input);
    setBusy(true);
    const svc = await getOfflineServices();
    const queue = async () => {
      if (!svc) throw new NetworkError("réseau indisponible");
      await svc.queue.enqueue(input, clientId); // brouillon seulement, même si « valider » était demandé
      window.dispatchEvent(new CustomEvent("arcompt:drafts-changed"));
      setSuccess({ text: t("entries.queued") });
      reset();
    };
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await queue();
        return;
      }
      const entry = await apiClient<JournalEntry>("/entries", { method: "POST", body: { ...input, clientId, validate } });
      await svc?.recent.upsert(toRecentEntry(entry));
      window.dispatchEvent(new CustomEvent("arcompt:drafts-changed"));
      setSuccess({ text: validate ? t("entries.createdValidated", { number: entry.number ?? "?" }) : t("entries.created"), id: entry.id });
      reset();
    } catch (err) {
      if (err instanceof NetworkError || (err instanceof ApiError && err.status === 502)) {
        try {
          await queue();
        } catch (e2) {
          setError(errorMessage(e2));
        }
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e, false)} className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("entries.form.journal")}>
          <Select value={journalCode} onChange={(e) => setJournalCode(e.target.value)}>
            {JOURNAL_CODES.map((c) => (
              <option key={c} value={c}>
                {c} — {t(`journal.${c}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("entries.form.date")}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label={`${t("entries.form.reference")} (${t("common.optional")})`}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
        </Field>
        <Field label={t("entries.form.label")} className="sm:col-span-4">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} required />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t("entries.form.lines")}</legend>
        <div className="space-y-2">
          <div className="hidden grid-cols-[minmax(9rem,1.2fr)_2fr_1fr_1fr_auto] gap-2 text-xs uppercase tracking-wide text-slate-500 sm:grid">
            <span>{t("entries.form.account")}</span>
            <span>{t("entries.form.lineLabel")}</span>
            <span className="text-right">{t("common.debit")}</span>
            <span className="text-right">{t("common.credit")}</span>
            <span />
          </div>
          {lines.map((l) => (
            <div key={l.key} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-[minmax(9rem,1.2fr)_2fr_1fr_1fr_auto] sm:border-0 sm:p-0 dark:border-slate-800">
              <div className="col-span-2 sm:col-span-1">
                <AccountPicker accounts={accounts ?? null} value={l.accountNumber} onChange={(n) => update(l.key, { accountNumber: n })} />
              </div>
              <Input value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} placeholder={t("entries.form.lineLabel")} className="col-span-2 sm:col-span-1" maxLength={200} />
              <Input value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })} placeholder={t("common.debit")} inputMode="decimal" className="text-right font-mono" />
              <Input value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, ...(e.target.value ? { debit: "" } : {}) })} placeholder={t("common.credit")} inputMode="decimal" className="text-right font-mono" />
              <Button variant="ghost" size="sm" onClick={() => remove(l.key)} disabled={lines.length <= 2} aria-label={t("entries.form.removeLine")} className="col-span-2 sm:col-span-1">
                ✕
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
            + {t("entries.form.addLine")}
          </Button>
          <div className="text-sm">
            <span className="mr-3">
              {t("common.debit")} <Money value={totals.debit} currency={currency} className="font-semibold" />
            </span>
            <span className="mr-3">
              {t("common.credit")} <Money value={totals.credit} currency={currency} className="font-semibold" />
            </span>
            {totals.balanced ? (
              <span className="text-emerald-700 dark:text-emerald-300">{t("entries.form.balanced")}</span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">{t("entries.form.unbalanced", { diff: "" })}<Money value={totals.diff} currency={currency} /></span>
            )}
          </div>
        </div>
      </fieldset>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {success ? (
        <Alert tone="success">
          {success.text}{" "}
          {success.id ? (
            <>
              <span className="font-mono text-xs">{success.id}</span> ·{" "}
              <Link href="/entries" className="underline">
                {t("nav.entries")}
              </Link>
            </>
          ) : null}
        </Alert>
      ) : null}
      <p className="text-[11px] text-slate-400">
        clientId <span className="font-mono">{clientId}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={busy}>
          {t("entries.form.submitDraft")}
        </Button>
        <Button type="button" onClick={(e) => void submit(e, true)} disabled={busy}>
          {busy ? t("common.loading") : t("entries.form.submitValidate")}
        </Button>
      </div>
    </form>
  );
}
