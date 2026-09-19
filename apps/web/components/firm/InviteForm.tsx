"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { MEMBER_ROLES, type CompanySummary, type InviteResult, type MemberRole } from "./types";

/** Inviter un collaborateur : e-mail, rôle, dossiers (POST /portal/org/invitations). Le jeton est montré une seule fois. */
export function InviteForm({ companies }: { companies: CompanySummary[] }) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("ACCOUNTANT");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient<InviteResult>("/portal/org/invitations", { method: "POST", body: { email: email.trim(), role, companyIds: [...selected] } });
      setResult(r);
      setEmail("");
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("firm.invitations.email")}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label={t("firm.members.role")}>
          <Select value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
            {MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`firm.role.${r}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{t("firm.invitations.companies")}</legend>
        {companies.length === 0 ? <p className="text-xs text-slate-500">{t("firm.companies.empty")}</p> : null}
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {companies.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="truncate">{c.name}</span>
                <span className="font-mono text-[10px] text-slate-400">{c.id.slice(0, 8)}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <Alert tone="success">
          {t("firm.invitations.sent", { email: result.invitation.email })}
          <span className="mt-1 block text-xs">{t("firm.invitations.tokenHint")}</span>
          <code className="mt-1 block break-all rounded bg-white/60 px-2 py-1 font-mono text-xs dark:bg-slate-900/60">{result.token}</code>
        </Alert>
      ) : null}
      <Button type="submit" disabled={busy || selected.size === 0 || !email.trim()}>{busy ? t("common.loading") : t("firm.invitations.invite")}</Button>
    </form>
  );
}
