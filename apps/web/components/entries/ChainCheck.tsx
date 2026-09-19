"use client";
import { useState } from "react";
import { apiClient, errorMessage, useMutation } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { JOURNAL_CODES, type ChainReport } from "@/lib/types";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";

/** Vérification de la chaîne de hachage d'un journal (GET /v1/entries/chain/:journal). */
export function ChainCheck() {
  const t = useT();
  const [journal, setJournal] = useState<string>("VT");
  const m = useMutation((code: string) => apiClient<ChainReport>(`/entries/chain/${code}`));
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Select value={journal} onChange={(e) => setJournal(e.target.value)} aria-label={t("common.journal")} className="max-w-[14rem]">
          {JOURNAL_CODES.map((c) => (
            <option key={c} value={c}>
              {c} — {t(`journal.${c}`)}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={() => void m.mutate(journal)} disabled={m.isLoading}>
          {m.isLoading ? t("common.loading") : t("entries.chainCheck")}
        </Button>
      </div>
      {m.status === "success" && m.data ? (
        <Alert tone={m.data.ok ? "success" : "danger"}>{m.data.ok ? t("entries.chainOk", { checked: m.data.checked }) : t("entries.chainBroken", { id: m.data.brokenAt ?? "?", checked: m.data.checked })}</Alert>
      ) : null}
      {m.status === "error" ? <Alert tone="danger">{errorMessage(m.error)}</Alert> : null}
    </div>
  );
}
