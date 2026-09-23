// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Input } from "@/components/ui/Field";
import { EntryActionButtons } from "./EntryActionButtons";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Agir sur une écriture par identifiant (tant que l'API ne liste pas les écritures). */
export function EntryByIdActions() {
  const t = useT();
  const [id, setId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const valid = UUID_RE.test(id.trim());
  return (
    <div className="space-y-3">
      <Input value={id} onChange={(e) => setId(e.target.value)} placeholder={t("entries.entryId")} aria-label={t("entries.entryId")} className="font-mono text-xs" />
      {valid ? <EntryActionButtons id={id.trim()} onDone={setMessage} /> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
    </div>
  );
}
