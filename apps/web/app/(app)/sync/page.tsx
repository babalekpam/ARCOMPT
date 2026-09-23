// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { getT } from "@/lib/i18n-server";
import { PageHeader } from "@/components/ui/PageHeader";
import { SyncCenter } from "@/components/pwa/SyncCenter";

/**
 * Centre de synchronisation. Aucune lecture serveur : la page doit s'ouvrir
 * hors ligne, servie par le cache du service worker, et n'affiche que ce que
 * l'appareil détient (docs/OFFLINE.md).
 */
export default async function SyncPage() {
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t("offline.center.title")} subtitle={t("offline.center.subtitle")} />
      <SyncCenter />
    </>
  );
}
