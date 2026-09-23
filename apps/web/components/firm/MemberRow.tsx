// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select } from "@/components/ui/Field";
import { MEMBER_ROLES, type CompanyMember, type MemberRole } from "./types";

/** Ligne d'un membre : changer le rôle (PUT) ou retirer (DELETE), propriétaire uniquement. */
export function MemberRow({ member, canEdit }: { member: CompanyMember; canEdit: boolean }) {
  const t = useT();
  const router = useRouter();
  const [role, setRole] = useState<MemberRole>(member.role);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setMemberRole = async (next: MemberRole) => {
    const prev = role;
    setRole(next);
    setBusy(true);
    setError(null);
    try {
      const m = await apiClient<CompanyMember>(`/portal/org/members/${member.companyId}/${member.userId}`, { method: "PUT", body: { role: next } });
      setRole(m.role);
      router.refresh();
    } catch (e) {
      setRole(prev);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient<void>(`/portal/org/members/${member.companyId}/${member.userId}`, { method: "DELETE" });
      setConfirm(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td className="py-1.5 pr-3">
        <span className="font-medium">{member.displayName ?? member.email ?? t("firm.members.external")}</span>
        {member.email && member.displayName ? <span className="ml-1 text-xs text-slate-500">{member.email}</span> : null}
        <p className="font-mono text-xs text-slate-500">{member.reference ?? t("firm.members.referenceUnavailable")}</p>
      </td>
      <td className="py-1.5 pr-3">
        {canEdit ? (
          <Select value={role} onChange={(e) => void setMemberRole(e.target.value as MemberRole)} disabled={busy} aria-label={t("firm.members.role")} className="w-40">
            {MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`firm.role.${r}`)}
              </option>
            ))}
          </Select>
        ) : (
          t(`firm.role.${role}`)
        )}
        {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
      </td>
      <td className="py-1.5 text-right">
        {canEdit ? (
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)} disabled={busy}>
            {t("firm.members.remove")}
          </Button>
        ) : null}
        <ConfirmDialog open={confirm} title={t("firm.members.remove")} confirmVariant="danger" busy={busy} onConfirm={() => void remove()} onCancel={() => !busy && setConfirm(false)}>
          {t("firm.members.removeConfirm", { name: member.displayName ?? member.email ?? member.reference ?? t("firm.members.external"), company: member.companyName })}
        </ConfirmDialog>
      </td>
    </tr>
  );
}
