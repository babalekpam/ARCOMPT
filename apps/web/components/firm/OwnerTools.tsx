"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import type { AppUser } from "./types";

/** « Suspendre les comptes inactifs » (POST /portal/org/members/suspend-inactive, propriétaire) avec confirmation. */
export function SuspendInactiveButton({ defaultDays = 90 }: { defaultDays?: number }) {
  const t = useT();
  const router = useRouter();
  const [days, setDays] = useState(String(defaultDays));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const n = Number(days);
  const valid = Number.isInteger(n) && n > 0;

  const run = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const users = await apiClient<AppUser[]>("/portal/org/members/suspend-inactive", { method: "POST", body: { days: n } });
      setNotice({ tone: users.length ? "success" : "info", text: t("firm.entitlements.suspended", { n: users.length, days: n }) + (users.length ? " — " + users.map((u) => u.email || u.displayName).join(", ") : "") });
      setOpen(false);
      router.refresh();
    } catch (e) {
      setNotice({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-500">
          {t("firm.entitlements.days")}
          <Input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className="mt-1 w-24" />
        </label>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)} disabled={!valid || busy} className="self-end">
          {t("firm.entitlements.suspend")}
        </Button>
      </div>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <ConfirmDialog open={open} title={t("firm.entitlements.suspend")} confirmVariant="danger" busy={busy} onConfirm={() => void run()} onCancel={() => !busy && setOpen(false)}>
        {t("firm.entitlements.suspendConfirm", { days: n })}
      </ConfirmDialog>
    </div>
  );
}
