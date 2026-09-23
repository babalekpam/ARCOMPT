// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { getT } from "@/lib/i18n-server";
import { EmployeeForm } from "@/components/payroll/EmployeeForm";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function NewEmployeePage() {
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t("payroll.employee.new")} subtitle={t("payroll.employee.newHint")} />
      <Card>
        <EmployeeForm />
      </Card>
    </>
  );
}
