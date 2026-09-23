// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { PackNotice } from "@/components/packs/PackNotice";
import { payslipDraftPack } from "@/components/payroll/helpers";
import { PrintButton } from "@/components/payroll/PrintButton";
import type { PayslipLine, PayslipView } from "@/components/payroll/types";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, locale } = await getT();
  const res = await apiTry<PayslipView>(`/payroll/payslips/${id}`);
  if (!res.ok && "status" in res.error && res.error.isNotFound) notFound();

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title={t("payroll.payslip.title")}
          subtitle={res.ok ? res.data.run.periodLabel : undefined}
          actions={
            <>
              {res.ok ? (
                <LinkButton href={`/payroll/runs/${res.data.run.id}`} variant="secondary" size="sm">
                  {t("payroll.payslip.backToRun")}
                </LinkButton>
              ) : null}
              <PrintButton />
            </>
          }
        />
      </div>
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok ? <PayslipSheet view={res.data} locale={locale} t={t} /> : null}
    </>
  );
}

function PayslipSheet({ view, locale, t }: { view: PayslipView; locale: "fr" | "en"; t: (k: string, p?: Record<string, string | number | undefined>) => string }) {
  const c = view.company.currency;
  const s = view.sections;
  // La mention est *dans* l'article : c'est lui que la boîte d'impression
  // reproduit (seul l'en-tête de page porte `print:hidden`), donc le bulletin
  // ne peut pas être imprimé sans elle.
  const draftPack = payslipDraftPack(view);
  return (
    <article className="mx-auto max-w-4xl space-y-4 print:max-w-none">
      {draftPack ? <PackNotice surface="payslip" pack={draftPack} /> : null}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-lg font-semibold">{view.company.name}</p>
            <p className="text-xs text-slate-500">
              {view.company.countryCode.toUpperCase()} · {c} · {t("payroll.payslip.pack", { pack: view.run.packVersion })}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold uppercase tracking-wide">{t("payroll.payslip.heading")}</p>
            <p className="text-sm">{view.run.periodLabel}</p>
            <p className="font-mono text-[11px] text-slate-400">{view.payslip.id}</p>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <Item label={t("payroll.employee.one")} value={view.employee.fullName} />
          <Item label={t("payroll.employee.matricule")} value={view.employee.matricule} mono />
          <Item label={t("payroll.employee.contractType")} value={t(`payroll.contractType.${view.employee.contractType}`)} />
          <Item label={t("payroll.employee.hireDate")} value={formatDate(locale, view.employee.hireDate)} />
          <Item label={t("payroll.employee.category")} value={view.employee.category ?? "—"} />
          <Item label={t("payroll.employee.dependants")} value={String(view.employee.dependants)} />
          <Item label={t("payroll.employee.ssn")} value={view.employee.socialSecurityNumber ?? "—"} mono />
          <Item label={t("payroll.employee.bank")} value={view.employee.bankDetails ? [view.employee.bankDetails.bank, view.employee.bankDetails.iban ?? view.employee.bankDetails.rib ?? view.employee.bankDetails.mobileMoney].filter(Boolean).join(" · ") || "—" : "—"} mono />
        </dl>
      </Card>

      <Card>
        <CardTitle>{t("payroll.payslip.lines")}</CardTitle>
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 text-left">{t("common.label")}</th>
              <th className="py-1 text-right">{t("payroll.payslip.base")}</th>
              <th className="py-1 text-right">{t("payroll.payslip.rate")}</th>
              <th className="py-1 text-right">{t("payroll.payslip.earning")}</th>
              <th className="py-1 text-right">{t("payroll.payslip.deduction")}</th>
              <th className="py-1 text-right">{t("payroll.payslip.employer")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            <Section title={t("payroll.payslip.earnings")} lines={s.earnings} currency={c} side="earning" />
            <Section title={t("payroll.payslip.deductions")} lines={s.deductions} currency={c} side="deduction" />
            <Section title={t("payroll.payslip.contributions")} lines={s.contributions} currency={c} side="deduction" employer />
            <Section title={t("payroll.payslip.taxes")} lines={s.taxes} currency={c} side="deduction" />
            <Section title={t("payroll.payslip.advances")} lines={s.advances} currency={c} side="deduction" />
          </tbody>
        </table>
      </Card>

      <Card>
        <CardTitle>{t("payroll.payslip.totals")}</CardTitle>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Total label={t("payroll.gross")} value={view.totals.gross} currency={c} />
          <Total label={t("payroll.payslip.taxableBase")} value={view.totals.taxableBase} currency={c} />
          <Total label={t("payroll.employeeContributions")} value={view.totals.employeeContributions} currency={c} />
          <Total label={t("payroll.incomeTax")} value={view.totals.incomeTax} currency={c} />
          <Total label={t("payroll.net")} value={view.totals.net} currency={c} />
          <Total label={t("payroll.run.advance")} value={view.totals.advance} currency={c} />
          <Total label={t("payroll.employerContributions")} value={view.totals.employerContributions} currency={c} />
          <Total label={t("payroll.employerCost")} value={view.totals.employerCost} currency={c} />
          <Total label={t("payroll.netToPay")} value={view.totals.netToPay} currency={c} strong />
        </dl>
      </Card>
    </article>
  );
}

function Item({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
}

function Section({ title, lines, currency, side, employer = false }: { title: string; lines: Array<PayslipLine & { formatted: string }>; currency: string; side: "earning" | "deduction"; employer?: boolean }) {
  if (lines.length === 0) return null;
  return (
    <>
      <tr className="bg-slate-50 text-xs font-semibold uppercase tracking-wide dark:bg-slate-800/60">
        <td colSpan={6} className="px-1 py-1">{title}</td>
      </tr>
      {lines.map((l) => (
        <tr key={l.id}>
          <td className="py-1 pl-3">
            {l.label}
            <span className="ml-2 font-mono text-[10px] text-slate-400">{l.account}</span>
          </td>
          <td className="py-1 text-right"><Money value={l.base} currency={currency} dashForZero /></td>
          <td className="py-1 text-right font-mono text-xs text-slate-500">{l.rate ?? ""}</td>
          <td className="py-1 text-right">{side === "earning" ? <Money value={l.employee_amount} currency={currency} /> : null}</td>
          <td className="py-1 text-right">{side === "deduction" ? <Money value={l.employee_amount} currency={currency} dashForZero /> : null}</td>
          <td className="py-1 text-right text-slate-500">{employer ? <Money value={l.employer_amount} currency={currency} dashForZero /> : null}</td>
        </tr>
      ))}
    </>
  );
}

function Total({ label, value, currency, strong = false }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <div className={strong ? "col-span-2 rounded-lg bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900 sm:col-span-3" : ""}>
      <dt className={`text-[11px] uppercase tracking-wide ${strong ? "opacity-80" : "text-slate-500"}`}>{label}</dt>
      <dd className={strong ? "text-xl font-semibold" : "font-medium"}>
        <Money value={value} currency={currency} showCurrency />
      </dd>
    </div>
  );
}
