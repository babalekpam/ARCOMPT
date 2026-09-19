"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { PostTransactionDialog } from "./PostTransactionDialog";
import { TRANSACTION_STATUSES, type AutoMatchResult, type BankStatement, type BankTransaction, type LedgerLineCandidate, type TransactionStatus } from "./types";

/**
 * Lignes d'un relevé : sélection du relevé, filtre par statut, rapprochement
 * automatique (résultats par ligne), rapprochement manuel (candidats du grand
 * livre), dé-rapprochement, ignorer, comptabiliser. Tout passe par le proxy.
 */
export function TransactionsPanel({ accountId, statements, currency, initialStatementId }: { accountId: string; statements: BankStatement[]; currency: string; initialStatementId?: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [statementId, setStatementId] = useState(initialStatementId ?? statements[0]?.id ?? "");
  const [status, setStatus] = useState<"" | TransactionStatus>("");
  const [rows, setRows] = useState<BankTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [autoResult, setAutoResult] = useState<AutoMatchResult | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [matching, setMatching] = useState<BankTransaction | null>(null);
  const [candidates, setCandidates] = useState<LedgerLineCandidate[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [posting, setPosting] = useState<BankTransaction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!statementId) return setRows([]);
    try {
      const data = await apiClient<BankTransaction[]>(`/treasury/statements/${statementId}/transactions`, { query: { status: status || undefined } });
      setRows(data);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(errorMessage(e));
    }
  }, [statementId, status]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const act = async (tx: BankTransaction, action: "unmatch" | "ignore") => {
    setBusyId(tx.id);
    setError(null);
    try {
      await apiClient<BankTransaction>(`/treasury/transactions/${tx.id}/${action}`, { method: "POST", body: {} });
      await load();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const openMatch = async (tx: BankTransaction) => {
    setMatching(tx);
    setCandidates(null);
    setChosen("");
    try {
      const c = await apiClient<LedgerLineCandidate[]>(`/treasury/transactions/${tx.id}/candidates`);
      setCandidates(c);
      if (c[0]) setChosen(c[0].lineId);
    } catch (e) {
      setCandidates([]);
      setError(errorMessage(e));
    }
  };

  const confirmMatch = async () => {
    if (!matching || !chosen) return;
    setBusyId(matching.id);
    try {
      await apiClient<BankTransaction>(`/treasury/transactions/${matching.id}/match`, { method: "POST", body: { lineId: chosen } });
      setMatching(null);
      await load();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const autoMatch = async () => {
    setAutoBusy(true);
    setError(null);
    try {
      const r = await apiClient<AutoMatchResult>(`/treasury/accounts/${accountId}/auto-match`, { method: "POST", body: statementId ? { statementId } : {} });
      setAutoResult(r);
      await load();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAutoBusy(false);
    }
  };

  const decisionOf = (id: string) => autoResult?.decisions.find((d) => d.transactionId === id);
  const tone = (s: TransactionStatus) => (s === "MATCHED" ? "success" : s === "IGNORED" ? "neutral" : "warning");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">
          {t("treasury.statements.title")}
          <Select value={statementId} onChange={(e) => setStatementId(e.target.value)} className="mt-1 min-w-[14rem]">
            {statements.length === 0 ? <option value="">{t("treasury.statements.none")}</option> : null}
            {statements.map((s) => (
              <option key={s.id} value={s.id}>
                {formatDate(locale, s.periodFrom)} → {formatDate(locale, s.periodTo)} · {s.source}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-slate-500">
          {t("common.status")}
          <Select value={status} onChange={(e) => setStatus(e.target.value as "" | TransactionStatus)} className="mt-1">
            <option value="">{t("common.all")}</option>
            {TRANSACTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`treasury.txStatus.${s}`)}
              </option>
            ))}
          </Select>
        </label>
        <Button variant="secondary" onClick={() => void autoMatch()} disabled={autoBusy || statements.length === 0}>
          {autoBusy ? t("common.loading") : t("treasury.match.auto")}
        </Button>
      </div>
      {autoResult ? (
        <Alert tone={autoResult.unmatched === 0 ? "success" : "info"}>
          {t("treasury.match.autoResult", { matched: autoResult.matched, unmatched: autoResult.unmatched, llm: autoResult.llmConsulted })}
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {rows === null ? <p className="text-xs text-slate-500">{t("common.loading")}</p> : null}
      {rows && rows.length === 0 ? <p className="text-sm text-slate-500">{t("treasury.transactions.empty")}</p> : null}
      {rows && rows.length > 0 ? (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2 pr-3">{t("common.date")}</th>
                <th className="py-2 pr-3">{t("common.label")}</th>
                <th className="py-2 pr-3">{t("common.reference")}</th>
                <th className="py-2 pr-3 text-right">{t("common.amount")}</th>
                <th className="py-2 pr-3">{t("common.status")}</th>
                <th className="py-2">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((tx) => {
                const d = decisionOf(tx.id);
                return (
                  <tr key={tx.id}>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(locale, tx.date)}</td>
                    <td className="py-1.5 pr-3">
                      {tx.label}
                      {d && !d.autoMatch ? <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">{t(`treasury.match.reason.${d.reason}`)}{d.suggestedAccountNumber ? ` → ${d.suggestedAccountNumber}` : ""}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{tx.reference ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-right"><Money value={tx.amount} currency={currency} colorSign /></td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={tone(tx.status)}>{t(`treasury.txStatus.${tx.status}`)}</Badge>
                      {tx.status === "MATCHED" && tx.matchMethod ? <span className="ml-1 text-[11px] text-slate-500">{t(`treasury.matchMethod.${tx.matchMethod}`)}{tx.matchConfidence !== null ? ` ${Math.round(tx.matchConfidence * 100)}%` : ""}</span> : null}
                    </td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {tx.status === "UNMATCHED" ? (
                          <>
                            <Button size="sm" onClick={() => void openMatch(tx)} disabled={busyId === tx.id}>{t("treasury.match.manual")}</Button>
                            <Button size="sm" variant="secondary" onClick={() => setPosting(tx)} disabled={busyId === tx.id}>{t("treasury.post.title")}</Button>
                            <Button size="sm" variant="ghost" onClick={() => void act(tx, "ignore")} disabled={busyId === tx.id}>{t("treasury.match.ignore")}</Button>
                          </>
                        ) : null}
                        {tx.status === "MATCHED" ? <Button size="sm" variant="secondary" onClick={() => void act(tx, "unmatch")} disabled={busyId === tx.id}>{t("treasury.match.unmatch")}</Button> : null}
                        {tx.status === "IGNORED" ? <Button size="sm" variant="secondary" onClick={() => void act(tx, "unmatch")} disabled={busyId === tx.id}>{t("treasury.match.restore")}</Button> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <ConfirmDialog
        open={matching !== null}
        title={t("treasury.match.manual")}
        confirmLabel={t("treasury.match.confirm")}
        busy={busyId !== null}
        onConfirm={() => void confirmMatch()}
        onCancel={() => {
          if (busyId === null) setMatching(null);
        }}
      >
        {matching ? (
          <p className="mb-2">
            {formatDate(locale, matching.date)} · {matching.label} · <Money value={matching.amount} currency={currency} colorSign className="font-semibold" />
          </p>
        ) : null}
        {candidates === null ? <p className="text-xs text-slate-500">{t("common.loading")}</p> : null}
        {candidates && candidates.length === 0 ? <p className="text-sm text-slate-500">{t("treasury.match.noCandidate")}</p> : null}
        {candidates && candidates.length > 0 ? (
          <ul className="max-h-64 space-y-1 overflow-auto">
            {candidates.map((c) => (
              <li key={c.lineId}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                  <input type="radio" name="candidate" value={c.lineId} checked={chosen === c.lineId} onChange={() => setChosen(c.lineId)} className="mt-1" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.entryLabel || c.label}</span>
                    <span className="block text-xs text-slate-500">
                      {c.journalCode} {c.entryNumber ?? "—"} · {formatDate(locale, c.date)}
                      {c.reference ? ` · ${c.reference}` : ""}
                    </span>
                  </span>
                  <Money value={c.amount} currency={currency} colorSign className="font-semibold" />
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>

      <PostTransactionDialog
        tx={posting}
        currency={currency}
        onClose={() => setPosting(null)}
        onPosted={(entry) => {
          setPosting(null);
          setNotice(t("treasury.post.done", { number: entry.number ?? entry.id.slice(0, 8) }));
          void load();
          router.refresh();
        }}
      />
    </div>
  );
}
