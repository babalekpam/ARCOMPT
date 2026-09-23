// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { getT } from "@/lib/i18n-server";
import { WhatsAppLinkForm } from "@/components/documents/WhatsAppLinkForm";
import { Alert } from "@/components/ui/Alert";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

/** Paramètres WhatsApp : comment lier un numéro au dossier courant, puis envoyer des pièces par message. */
export default async function WhatsAppSettingsPage() {
  const { t } = await getT();
  return (
    <>
      <PageHeader
        title={t("documents.whatsapp.title")}
        subtitle={t("documents.whatsapp.subtitle")}
        actions={
          <Link href="/settings" className="text-sm underline">
            {t("settings.title")}
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>{t("documents.whatsapp.howto")}</CardTitle>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>{t("documents.whatsapp.step1")}</li>
            <li>{t("documents.whatsapp.step2")}</li>
            <li>{t("documents.whatsapp.step3")}</li>
            <li>{t("documents.whatsapp.step4")}</li>
          </ol>
          <Alert tone="info" className="mt-4">{t("documents.whatsapp.security")}</Alert>
        </Card>
        <Card>
          <CardTitle hint={t("documents.whatsapp.formHint")}>{t("documents.whatsapp.link")}</CardTitle>
          <WhatsAppLinkForm />
        </Card>
      </div>
    </>
  );
}
