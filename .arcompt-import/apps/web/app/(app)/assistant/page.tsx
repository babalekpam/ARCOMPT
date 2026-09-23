// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { getT } from "@/lib/i18n-server";
import { AssistantChat } from "@/components/assistant/AssistantChat";
import { DocumentsNav } from "@/components/documents/DocumentsNav";
import { PageHeader } from "@/components/ui/PageHeader";

/** Assistant comptable : questions en langage naturel, outils de lecture seule, réponse avec pied de page obligatoire. */
export default async function AssistantPage() {
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t("assistant.title")} subtitle={t("assistant.subtitle")} />
      <DocumentsNav />
      <div className="max-w-3xl">
        <AssistantChat />
      </div>
    </>
  );
}
