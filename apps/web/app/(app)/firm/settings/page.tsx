// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FirmNav } from "@/components/firm/FirmNav";
import { canActAsOwner, isMonth, monthOf, quotaPercent } from "@/components/firm/helpers";
import { SuspendInactiveButton } from "@/components/firm/OwnerTools";
import { myRole } from "@/components/firm/queries";
import type { AdminAccessRecord, BreakGlassRequest, EntitlementReviewItem, UsageReport, WhiteLabelSettings } from "@/components/firm/types";
import { WhiteLabelForm } from "@/components/firm/WhiteLabelForm";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";

function Quota({ label, used, quota, exceeded }: { label: string; used: number; quota: number | null; exceeded: boolean }) {
  const pct = quotaPercent(used, quota);
  return (
    <li className="py-2">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className={`tabular-nums ${exceeded ? "font-semibold text-red-600" : ""}`}>
          {used}
          {quota !== null ? ` / ${quota}` : ""}
        </span>
      </div>
      {pct !== null ? (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-100 dark:bg-slate-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full ${exceeded ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </li>
  );
}

/** Réglages du cabinet : marque blanche, usage / quotas, journal des accès admin, accès d'urgence, revue des habilitations. */
export default async function FirmSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const auth = await requireAuthContext();
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : monthOf(new Date().toISOString());
  const [whiteLabel, usage, adminAccess, breakGlass, entitlements, me] = await Promise.all([
    apiTry<WhiteLabelSettings>("/portal/org/white-label"),
    apiTry<UsageReport>("/portal/usage", { query: { month } }),
    apiTry<AdminAccessRecord[]>("/portal/admin-access"),
    apiTry<BreakGlassRequest[]>("/portal/break-glass"),
    apiTry<EntitlementReviewItem[]>("/portal/org/entitlement-review"),
    myRole(auth.userId, auth.tenantId),
  ]);
  const owner = canActAsOwner(me.role);
  return (
    <>
      <PageHeader title={t("firm.settings.title")} subtitle={t("firm.settings.subtitle")} />
      <FirmNav />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle hint={t("firm.whiteLabel.hint")}>{t("firm.whiteLabel.title")}</CardTitle>
          {!whiteLabel.ok ? <ApiErrorNotice error={whiteLabel.error} /> : <WhiteLabelForm settings={whiteLabel.data} canEdit={owner} />}
        </Card>
        <Card>
          <CardTitle
            hint={t("firm.usage.hint")}
            action={
              <form method="get" className="flex items-end gap-2">
                <Input type="month" name="month" defaultValue={month} aria-label={t("firm.billing.month")} className="w-40" />
                <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                  {t("common.apply")}
                </button>
              </form>
            }
          >
            {t("firm.usage.title")}
          </CardTitle>
          {!usage.ok ? <ApiErrorNotice error={usage.error} /> : null}
          {usage.ok ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              <Quota label={t("firm.usage.aiCalls")} used={usage.data.aiCalls} quota={usage.data.quotas.aiCalls} exceeded={usage.data.exceeded.aiCalls} />
              <Quota label={t("firm.usage.documents")} used={usage.data.documents} quota={usage.data.quotas.documents} exceeded={usage.data.exceeded.documents} />
              <Quota label={t("firm.usage.whatsapp")} used={usage.data.whatsappMessages} quota={usage.data.quotas.whatsappMessages} exceeded={usage.data.exceeded.whatsappMessages} />
            </ul>
          ) : null}
        </Card>
        <Card>
          <CardTitle hint={t("firm.access.hint")}>{t("firm.access.title")}</CardTitle>
          {!adminAccess.ok ? <ApiErrorNotice error={adminAccess.error} /> : null}
          {adminAccess.ok && adminAccess.data.length === 0 ? <p className="text-sm text-slate-500">{t("firm.access.none")}</p> : null}
          {adminAccess.ok && adminAccess.data.length > 0 ? (
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {adminAccess.data.map((a) => (
                <li key={a.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{a.adminUserId}</span>
                    <span className="text-xs text-slate-500">{formatDate(locale, a.accessedAt)}</span>
                    {a.breakGlassRequestId ? <Badge tone="warning">{t("firm.access.breakGlass")}</Badge> : null}
                    <span className="ml-auto text-xs text-slate-500">{t("firm.access.notified", { n: a.notifiedCount })}</span>
                  </div>
                  <p className="text-xs">{a.reason}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <Card>
          <CardTitle hint={t("firm.breakGlass.hint")}>{t("firm.breakGlass.title")}</CardTitle>
          {!breakGlass.ok ? <ApiErrorNotice error={breakGlass.error} /> : null}
          {breakGlass.ok && breakGlass.data.length === 0 ? <p className="text-sm text-slate-500">{t("firm.breakGlass.none")}</p> : null}
          {breakGlass.ok && breakGlass.data.length > 0 ? (
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {breakGlass.data.map((b) => (
                <li key={b.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={b.active ? "danger" : b.status === "APPROVED" ? "info" : b.status === "PENDING" ? "warning" : "neutral"}>{b.active ? t("firm.breakGlass.active") : b.status}</Badge>
                    <span className="font-mono text-xs">{b.requesterId}</span>
                    <span className="text-xs text-slate-500">
                      {formatDate(locale, b.requestedAt)} → {formatDate(locale, b.expiresAt)}
                    </span>
                  </div>
                  <p className="text-xs">{b.reason}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle hint={t("firm.entitlements.hint")} action={owner ? <SuspendInactiveButton /> : null}>{t("firm.entitlements.title")}</CardTitle>
          {!entitlements.ok ? "status" in entitlements.error && entitlements.error.isAuth ? <Alert tone="info">{t("firm.ownerOnly")}</Alert> : <ApiErrorNotice error={entitlements.error} /> : null}
          {entitlements.ok && entitlements.data.length === 0 ? <p className="text-sm text-slate-500">{t("firm.members.none")}</p> : null}
          {entitlements.ok && entitlements.data.length > 0 ? (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("firm.members.member")}</th>
                    <th className="py-2 pr-3">{t("firm.dashboard.company")}</th>
                    <th className="py-2 pr-3">{t("firm.members.role")}</th>
                    <th className="py-2 pr-3">{t("firm.entitlements.lastActive")}</th>
                    <th className="py-2">{t("firm.entitlements.reasons")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {entitlements.data.map((e) => (
                    <tr key={`${e.companyId}-${e.userId}`}>
                      <td className="py-1.5 pr-3">
                        {e.displayName ?? e.email ?? e.userId}
                        {e.suspendedAt ? <Badge tone="danger" className="ml-2">{t("firm.entitlements.suspendedBadge")}</Badge> : null}
                      </td>
                      <td className="py-1.5 pr-3">{e.companyName}</td>
                      <td className="py-1.5 pr-3">{t(`firm.role.${e.role}`)}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(locale, e.lastActiveAt) || t("firm.entitlements.never")}</td>
                      <td className="py-1.5">
                        {e.reasons.length === 0 ? "—" : e.reasons.map((r) => <Badge key={r} tone={r === "SUSPENDED" || r === "INACTIVE" ? "danger" : "warning"} className="mr-1">{r}</Badge>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
