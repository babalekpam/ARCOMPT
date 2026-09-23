// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { config } from "@/lib/config";
import { getT } from "@/lib/i18n-server";
import { EntryForm } from "@/components/entries/EntryForm";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function NewEntryPage() {
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t("entries.form.title")} subtitle={t("entries.subtitle")} />
      <Card>
        <EntryForm currency={config.defaultCurrency()} />
      </Card>
    </>
  );
}
