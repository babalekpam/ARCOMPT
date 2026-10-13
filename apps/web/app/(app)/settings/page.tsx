// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link"; import { CompanyProfileForm } from "@/components/settings/CompanyProfileForm";
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { getCurrentMemberReference } from "@/lib/member-reference";
import type { Company, CountryPack, PackSummary } from "@/lib/types";
import { packStatusTone } from "@/components/packs/helpers";
import { LocaleSwitcher } from "@/components/shell/LocaleSwitcher";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`text-sm ${mono ? "font-mono text-xs" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const auth = await requireAuthContext();
  const sp = await searchParams;
  // Pays du dossier : via le portail quand il existe, sinon paramètre `pack` ou pack par défaut.
  const companies = await apiTry<{ companies?: Company[] } | Company[]>("/portal/org/companies");
  const list = companies.ok ? (Array.isArray(companies.data) ? companies.data : (companies.data.companies ?? [])) : [];
  const company = list.find((c) => c.id === auth.tenantId);
  const packCode = (typeof sp.pack === "string" && /^[a-z]{2}$/i.test(sp.pack) ? sp.pack : (company?.countryCode ?? process.env.DEFAULT_COUNTRY_PACK ?? "ci")).toLowerCase();
  const [packs, pack] = await Promise.all([apiTry<{ packs: PackSummary[] }>("/packs"), apiTry<CountryPack>(`/packs/${packCode}`)]);
  const memberReference = auth.tenantId ? await getCurrentMemberReference() : null;
  const entitlements = await apiTry<{
    planCode: string; label: string; currency: string; pricePerDossier: string;
    status: "TRIAL" | "TRIAL_EXPIRED" | "ACTIVE" | "ENDED";
    trialEndsAt: string | null; endedAt: string | null;
    features: { payroll: boolean; aiAssistant: boolean; whiteLabel: boolean; firmDashboard: boolean; maxUsers: number | null; maxDossiers: number | null };
    usage: { users: number; dossiers: number };
  }>("/portal/org/entitlements");

  return (
    <>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <CompanyProfileForm />
        </div>
        <Card>
          <CardTitle>Votre forfait</CardTitle>
          {entitlements.ok ? (
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Offre" value={<span className="font-medium">{entitlements.data.label}</span>} />
              <Row label="Statut" value={
                entitlements.data.status === "TRIAL" ? `Essai — jusqu’au ${entitlements.data.trialEndsAt ?? ""}` :
                entitlements.data.status === "TRIAL_EXPIRED" ? "Essai terminé — droits réduits à l’Essentiel" :
                entitlements.data.status === "ENDED" ? "Abonnement terminé — droits réduits à l’Essentiel" : "Actif"
              } />
              <Row label="Prix" value={Number(entitlements.data.pricePerDossier) > 0 ? `${Number(entitlements.data.pricePerDossier).toLocaleString("fr-FR")} ${entitlements.data.currency} / dossier / mois` : "Gratuit"} />
              <Row label="Utilisateurs" value={`${entitlements.data.usage.users} / ${entitlements.data.features.maxUsers ?? "∞"}`} />
              <Row label="Dossiers" value={`${entitlements.data.usage.dossiers} / ${entitlements.data.features.maxDossiers ?? "∞"}`} />
              <Row label="Paie" value={entitlements.data.features.payroll ? "Incluse" : "Non incluse (offre Pro)"} />
              <Row label="Assistant IA" value={entitlements.data.features.aiAssistant ? "Inclus" : "Non inclus (offre Pro)"} />
              <Row label="Marque blanche" value={entitlements.data.features.whiteLabel ? "Incluse" : "Non incluse (offre Cabinet)"} />
            </dl>
          ) : (
            <p className="py-2 text-sm text-slate-500">Forfait indisponible pour le moment.</p>
          )}
          <p className="mt-3 text-sm text-slate-500">
            Pour changer d’offre, écrivez à <a href="mailto:info@arcompt.com" className="underline underline-offset-4">info@arcompt.com</a> —{" "}
            <Link href="/pricing" className="underline underline-offset-4">voir les offres</Link>.
          </p>
        </Card>
        <Card>
          <CardTitle hint={t("settings.companyHint")} action={<Link href="/firm/members" className="text-sm font-medium text-teal-700 underline hover:text-teal-900 dark:text-teal-300">{t("nav.invitations")}</Link>}>{t("settings.company")}</CardTitle>
          <dl className="divide-y divide-slate-100 dark:divide-slate-800">
            {company ? <Row label={t("settings.company")} value={company.name} /> : null}
            <Row label={t("settings.tenantId")} value={auth.tenantId} mono />
            <Row label={t("settings.organizationId")} value={auth.organizationId} mono />
            <Row label={t("settings.userId")} value={memberReference ?? t("firm.members.referenceUnavailable")} mono />
            <Row label={t("settings.authMode")} value={<Badge tone={auth.mode === "dev" ? "warning" : "success"}>{auth.mode}</Badge>} />
            <Row label={t("settings.fiscalYear")} value={config.defaultFiscalYear()} />
            <Row label={t("common.currency")} value={config.defaultCurrency()} />
          </dl>
        </Card>
        <Card>
          <CardTitle>{t("settings.pack")}</CardTitle>
          {packs.ok && packs.data.packs.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-1">
              {packs.data.packs.map((p) => (
                <Link key={p.code} href={`/settings?pack=${p.code}`} className={`rounded-full border px-2 py-0.5 text-xs ${p.code === packCode ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 dark:border-slate-700"}`}>
                  {p.code.toUpperCase()} · {p.name}
                </Link>
              ))}
            </div>
          ) : null}
          {pack.ok ? (
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label={t("settings.packCode")} value={`${pack.data.code.toUpperCase()} — ${pack.data.name}`} />
              <Row label={t("settings.packVersion")} value={pack.data.version} />
              <Row label={t("settings.packStatus")} value={<Badge tone={packStatusTone(pack.data.status)}>{pack.data.status}</Badge>} />
              <Row label={t("settings.packCurrency")} value={pack.data.identity.currency} />
              <Row label={t("settings.packSystems")} value={pack.data.identity.accounting_systems.join(", ")} />
              <Row label={t("settings.packAuthority")} value={pack.data.identity.tax_authority} />
              <Row label={t("settings.packTaxIds")} value={pack.data.identity.tax_ids.map((x) => `${x.code} (${x.label})`).join(", ")} />
              <Row label={t("settings.packVat")} value={(pack.data.vat?.rates ?? []).map((r) => `${r.code} ${String(r.rate)}`).join(", ")} />
            </dl>
          ) : (
            <p className="text-sm text-slate-500">{t("settings.packUnavailable")}</p>
          )}
        </Card>
        <Card>
          <CardTitle>{t("settings.locale")}</CardTitle>
          <div className="flex items-center gap-3">
            <LocaleSwitcher />
            <span className="text-xs text-slate-500">{t(`locale.${locale}`)}</span>
          </div>
        </Card>
        <Card>
          <CardTitle>{t("settings.session")}</CardTitle>
          <p className="text-sm text-slate-500">{auth.mode === "dev" ? t("login.devHint") : "Keycloak OIDC"}</p>
          {auth.mode === "dev" ? (
            <Link href="/login" className="mt-2 inline-block text-sm underline">
              {t("settings.devLogin")}
            </Link>
          ) : null}
        </Card>
      </div>
    </>
  );
}
