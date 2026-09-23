// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ouvrir une pièce par identifiant (l'API n'expose pas de liste exhaustive des pièces). */
export function OpenDocumentForm() {
  const t = useT();
  const router = useRouter();
  const [id, setId] = useState("");
  const valid = UUID_RE.test(id.trim());
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) router.push(`/documents/${id.trim()}`);
      }}
    >
      <Input value={id} onChange={(e) => setId(e.target.value)} placeholder={t("documents.openByIdHint")} aria-label={t("documents.openById")} className="font-mono text-xs" />
      <Button type="submit" size="sm" disabled={!valid}>
        {t("documents.open")}
      </Button>
    </form>
  );
}
