// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { AcceptInvitationForm } from "@/components/firm/AcceptInvitationForm";
import { FirmNav } from "@/components/firm/FirmNav";
import { canActAsOwner, groupMembersByCompany } from "@/components/firm/helpers";
import { InviteForm } from "@/components/firm/InviteForm";
import { MemberRow } from "@/components/firm/MemberRow";
import { myRole } from "@/components/firm/queries";
import type { CompanySummary, Invitation } from "@/components/firm/types";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

/** Membres et invitations : inviter (rôle + dossiers), accepter avec jeton, rôles par dossier. */
export default async function FirmMembersPage() {
  const { t, locale } = await getT();
  const auth = await requireAuthContext();
  const [companies, invitations, me] = await Promise.all([apiTry<CompanySummary[]>("/portal/org/companies"), apiTry<Invitation[]>("/portal/org/invitations", { query: { pending: "true" } }), myRole(auth.userId, auth.tenantId)]);
  const owner = canActAsOwner(me.role);
  const companyNames = new Map((companies.ok ? companies.data : []).map((c) => [c.id, c.name]));
  const groups = groupMembersByCompany(me.members);
  return (
    <>
      <PageHeader title={t("firm.members.title")} subtitle={t("firm.members.subtitle")} />
      <FirmNav />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle hint={t("firm.invitations.hint")}>{t("firm.invitations.new")}</CardTitle>
          {!companies.ok ? <ApiErrorNotice error={companies.error} /> : null}
          <InviteForm companies={companies.ok ? companies.data : []} />
        </Card>
        <Card>
          <CardTitle hint={t("firm.invitations.acceptHint")}>{t("firm.invitations.accept")}</CardTitle>
          <AcceptInvitationForm />
        </Card>
      </div>
      <Card className="mt-4">
        <CardTitle>{t("firm.invitations.pending")}</CardTitle>
        {!invitations.ok ? <ApiErrorNotice error={invitations.error} /> : null}
        {invitations.ok && invitations.data.length === 0 ? <p className="text-sm text-slate-500">{t("firm.invitations.none")}</p> : null}
        {invitations.ok && invitations.data.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("firm.invitations.email")}</th>
                  <th className="py-2 pr-3">{t("firm.members.role")}</th>
                  <th className="py-2 pr-3">{t("firm.invitations.companies")}</th>
                  <th className="py-2">{t("firm.invitations.expires")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {invitations.data.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1.5 pr-3">{i.email}</td>
                    <td className="py-1.5 pr-3"><Badge tone="info">{t(`firm.role.${i.role}`)}</Badge></td>
                    <td className="py-1.5 pr-3 text-xs">{i.companyIds.map((id) => companyNames.get(id) ?? id.slice(0, 8)).join(", ")}</td>
                    <td className="py-1.5 whitespace-nowrap">{formatDate(locale, i.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <Card className="mt-4">
        <CardTitle hint={owner ? t("firm.members.hintOwner") : t("firm.ownerOnly")}>{t("firm.members.byCompany")}</CardTitle>
        {groups.length === 0 ? <p className="text-sm text-slate-500">{t("firm.members.none")}</p> : null}
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.companyId}>
              <h3 className="mb-1 text-sm font-semibold">
                {g.companyName} <span className="font-mono text-[10px] text-slate-400">{g.companyId.slice(0, 8)}</span>
              </h3>
              <div className="-mx-4 overflow-x-auto px-4">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">{t("firm.members.member")}</th>
                      <th className="py-2 pr-3">{t("firm.members.role")}</th>
                      <th className="py-2 text-right">{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {g.members.map((m) => (
                      <MemberRow key={`${m.companyId}-${m.userId}`} member={m} canEdit={owner} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      </Card>
    </>
  );
}
