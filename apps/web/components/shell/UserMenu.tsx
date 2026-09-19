"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useT } from "@/lib/i18n-client";
import { resetOfflineServices } from "@/lib/offline-browser";
import { Button } from "@/components/ui/Button";

export function UserMenu({ displayName }: { displayName: string }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const logout = () =>
    start(async () => {
      await fetch("/api/session/logout", { method: "POST" });
      resetOfflineServices();
      router.push("/login");
      router.refresh();
    });
  return (
    <div className="flex items-center gap-2">
      <span className="hidden max-w-[10rem] truncate text-xs text-slate-500 sm:inline" title={displayName}>
        {displayName}
      </span>
      <Button variant="ghost" size="sm" onClick={logout} disabled={pending}>
        {t("common.logout")}
      </Button>
    </div>
  );
}
