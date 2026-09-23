// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { getT } from "@/lib/i18n-server";
import { AssetForm } from "@/components/assets/AssetForm";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function NewAssetPage() {
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t("assets.new")} subtitle={t("assets.newHint")} />
      <Card>
        <AssetForm />
      </Card>
    </>
  );
}
