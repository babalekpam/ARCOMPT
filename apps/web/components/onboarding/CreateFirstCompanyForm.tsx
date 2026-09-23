// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";

import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { defaultFiscalYear } from "@/components/firm/helpers";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";

const COUNTRIES = [
  ["ci", "Côte d’Ivoire"],
  ["sn", "Sénégal"],
  ["cm", "Cameroun"],
  ["bj", "Bénin"],
  ["bf", "Burkina Faso"],
  ["ml", "Mali"],
  ["ne", "Niger"],
  ["tg", "Togo"],
] as const;

export function CreateFirstCompanyForm() {
  const fiscalYear = defaultFiscalYear(new Date().toISOString().slice(0, 10));
  const [name, setName] = useState("");
  const [packCode, setPackCode] = useState("ci");
  const [code, setCode] = useState(fiscalYear.code);
  const [startDate, setStartDate] = useState(fiscalYear.startDate);
  const [endDate, setEndDate] = useState(fiscalYear.endDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient<{ companyId: string }>("/session/bootstrap", {
        method: "POST",
        body: {
          name: name.trim(),
          countryCode: packCode.toUpperCase(),
          packCode,
          fiscalYear: { code: code.trim(), startDate, endDate },
        },
      });
      // The landing route reads the freshly committed membership and sets the
      // httpOnly tenant cookie. The browser cannot assign itself a company.
      window.location.assign("/api/session/landing");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4">
      <Field label="Nom de l’entreprise">
        <Input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={200} autoComplete="organization" />
      </Field>
      <Field label="Pays (référentiel comptable)">
        <Select value={packCode} onChange={(event) => setPackCode(event.target.value)}>
          {COUNTRIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Exercice">
          <Input value={code} onChange={(event) => setCode(event.target.value)} required maxLength={20} />
        </Field>
        <Field label="Début">
          <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
        </Field>
        <Field label="Fin">
          <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required min={startDate} />
        </Field>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" disabled={busy}>{busy ? "Création en cours…" : "Créer mon entreprise"}</Button>
    </form>
  );
}