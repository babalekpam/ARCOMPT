import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { EmployeeDeactivate } from "@/components/payroll/EmployeeDeactivate";
import { EmployeeForm } from "@/components/payroll/EmployeeForm";
import { employeeName, isMasked } from "@/components/payroll/helpers";
import type { Employee } from "@/components/payroll/types";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const { t, locale } = await getT();
  const res = await apiTry<Employee>(`/payroll/employees/${id}`);
  if (!res.ok && "status" in res.error && res.error.isNotFound) notFound();
  const currency = config.defaultCurrency();

  return (
    <>
      <PageHeader
        title={res.ok ? employeeName(res.data) : t("payroll.employee.one")}
        subtitle={res.ok ? `${t("payroll.employee.matricule")} ${res.data.matricule}` : undefined}
        actions={
          <>
            <LinkButton href="/payroll" variant="secondary" size="sm">
              {t("payroll.back")}
            </LinkButton>
            {res.ok && res.data.active && !isMasked(res.data.baseSalary) ? <EmployeeDeactivate id={res.data.id} name={employeeName(res.data)} /> : null}
          </>
        }
      />
      {sp.saved === "1" ? <Alert tone="success" className="mb-4">{t("payroll.employee.saved")}</Alert> : null}
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardTitle>{t("payroll.employee.edit")}</CardTitle>
            <EmployeeForm employee={res.data} />
          </Card>
          <Card>
            <CardTitle>{t("payroll.employee.summary")}</CardTitle>
            <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              <Row label={t("common.status")} value={<Badge tone={res.data.active ? "success" : "neutral"}>{res.data.active ? t("payroll.employee.activeBadge") : t("payroll.employee.inactiveBadge")}</Badge>} />
              <Row label={t("payroll.employee.contractType")} value={t(`payroll.contractType.${res.data.contractType}`)} />
              <Row label={t("payroll.employee.hireDate")} value={formatDate(locale, res.data.hireDate)} />
              {res.data.leaveDate ? <Row label={t("payroll.employee.leaveDate")} value={formatDate(locale, res.data.leaveDate)} /> : null}
              <Row label={t("payroll.employee.baseSalary")} value={isMasked(res.data.baseSalary) ? <span className="font-mono text-slate-400">***</span> : <Money value={res.data.baseSalary} currency={currency} showCurrency />} />
              <Row label={t("payroll.employee.dependants")} value={String(res.data.dependants)} />
              <Row label={t("payroll.employee.ssn")} value={<span className="font-mono text-xs">{res.data.socialSecurityNumber ?? "—"}</span>} />
              <Row label={t("payroll.employee.allowances")} value={String(res.data.allowances.length)} />
              <Row label="ID" value={<span className="font-mono text-[11px] text-slate-400">{res.data.id}</span>} />
            </dl>
          </Card>
        </div>
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
