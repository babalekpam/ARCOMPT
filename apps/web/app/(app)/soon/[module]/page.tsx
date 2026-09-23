// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n-server";
import { SOON_MODULES } from "@/lib/nav";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

/** Page « à venir » des modules des phases 2 et 3 (factures, trésorerie, paie…). */
export default async function ComingSoonPage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const key = SOON_MODULES[module];
  if (!key) notFound();
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t(key)} subtitle={t("soon.title")} />
      <EmptyState title={t("soon.title")} body={t("soon.body", { module: t(key) })} action={<LinkButton href="/">{t("soon.back")}</LinkButton>} icon="◌" />
    </>
  );
}
