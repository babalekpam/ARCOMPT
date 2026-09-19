import Link from "next/link";
import type { ReactNode } from "react";
import type { AuthContext } from "@/lib/auth";
import { getT } from "@/lib/i18n-server";
import { BottomNav } from "./BottomNav";
import { CompanySwitcher } from "./CompanySwitcher";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { SideNav } from "./SideNav";
import { UserMenu } from "./UserMenu";
import { OfflineIndicator } from "@/components/pwa/OfflineIndicator";

/** Coque applicative : en-tête, barre latérale (≥ md), barre inférieure (< md). */
export async function AppShell({ auth, children }: { auth: AuthContext; children: ReactNode }) {
  const { t } = await getT();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-slate-200 bg-slate-50 p-3 md:flex md:flex-col dark:border-slate-800 dark:bg-slate-900/50">
        <Link href="/" className="mb-4 flex items-center gap-2 px-3 py-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-900">A</span>
          <span className="text-lg font-semibold tracking-tight">{t("app.name")}</span>
        </Link>
        <SideNav />
        <p className="mt-auto px-3 pt-4 text-[11px] text-slate-400">{t("app.tagline")}</p>
      </aside>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
          <Link href="/" className="flex items-center gap-2 md:hidden">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-xs font-bold text-white dark:bg-slate-100 dark:text-slate-900">A</span>
            <span className="font-semibold">{t("app.name")}</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <CompanySwitcher tenantId={auth.tenantId} />
            <LocaleSwitcher compact />
            <UserMenu displayName={auth.displayName} />
          </div>
        </header>
        <OfflineIndicator />
        <main className="flex-1 px-4 pb-24 pt-5 md:px-8 md:pb-10">{children}</main>
      </div>
      <BottomNav />
    </div>
  );
}
