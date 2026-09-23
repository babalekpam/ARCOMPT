// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import type { Account, JournalEntry } from "@/lib/types";
import { AccountPicker } from "@/components/entries/AccountPicker";
import { PartnerPicker } from "@/components/invoicing/PartnerPicker";
import type { Partner } from "@/components/invoicing/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import type { BankTransaction } from "./types";

/**
 * « Comptabiliser » une ligne de relevé sans écriture correspondante :
 * choix du compte de contrepartie (plan de comptes), tiers facultatif, libellé,
 * puis POST /v1/treasury/transactions/:id/post (écriture BQ/CA rapprochée).
 */
export function PostTransactionDialog({ tx, currency, onClose, onPosted }: { tx: BankTransaction | null; currency: string; onClose: () => void; onPosted: (entry: JournalEntry) => void }) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[] | null | undefined>(undefined);
  const [accountNumber, setAccountNumber] = useState("");
  const [partner, setPartner] = useState<Partner | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tx || accounts !== undefined) return;
    apiClient<{ accounts: Account[] }>("/accounts")
      .then((d) => setAccounts(d.accounts.length > 0 ? d.accounts : null))
      .catch(() => setAccounts(null));
  }, [tx, accounts]);

  useEffect(() => {
    setAccountNumber("");
    setPartner(null);
    setLabel(tx?.label.slice(0, 200) ?? "");
    setError(null);
  }, [tx]);

  const run = async () => {
    if (!tx) return;
    if (!/^[1-9]\d{1,12}$/.test(accountNumber)) return setError(t("treasury.post.errorAccount"));
    setBusy(true);
    setError(null);
    try {
      const entry = await apiClient<JournalEntry>(`/treasury/transactions/${tx.id}/post`, { method: "POST", body: { accountNumber, ...(partner ? { partnerId: partner.id } : {}), ...(label.trim() ? { label: label.trim() } : {}) } });
      onPosted(entry);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={tx !== null}
      title={t("treasury.post.title")}
      confirmLabel={t("treasury.post.submit")}
      busy={busy}
      onConfirm={() => void run()}
      onCancel={() => {
        if (!busy) onClose();
      }}
    >
      {tx ? (
        <div className="space-y-3">
          <p>
            {tx.date} · {tx.label} · <Money value={tx.amount} currency={currency} colorSign className="font-semibold" />
          </p>
          <Field label={t("treasury.post.account")} hint={t("treasury.post.accountHint")}>
            <AccountPicker accounts={accounts ?? null} value={accountNumber} onChange={setAccountNumber} />
          </Field>
          <Field label={`${t("treasury.post.partner")} (${t("common.optional")})`}>
            <PartnerPicker types={[]} value={partner} onChange={setPartner} />
          </Field>
          <Field label={t("common.label")}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
          </Field>
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
