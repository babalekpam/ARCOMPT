// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import type { ReactNode } from "react";
import type { AuthContext } from "@/lib/auth";
import { getT } from "@/lib/i18n-server";
import { BrandLockup } from "@/components/brand/BrandMark";
import { BottomNav } from "./BottomNav";
import { CompanySwitcher } from "./CompanySwitcher";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { SideNav } from "./SideNav";
import { UserMenu } from "./UserMenu";
import { OfflineIndicator } from "@/components/pwa/OfflineIndicator";
import { getPlatformAdmin } from "@/lib/platform";
import { getCurrentMemberReference } from "@/lib/member-reference";
import { ReminderReviewAlert } from "./ReminderReviewAlert";
import { AdminModeSwitch } from "./AdminModeSwitch";

/** Coque applicative : en-tête, barre latérale (≥ md), barre inférieure (< md). */
export async function AppShell({ auth, children }: { auth: AuthContext; children: ReactNode }) {
  const { t } = await getT();
  const platformAdmin = await getPlatformAdmin();
  const reference = !platformAdmin && auth.tenantId ? await getCurrentMemberReference() : null;
  const displayName = platformAdmin ? t("settings.platformAdmin") : reference ?? t("firm.members.referenceUnavailable");
  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-slate-200 bg-[#F7F5F0] p-3 md:flex md:flex-col dark:border-slate-800 dark:bg-slate-900/50">
        <Link href="/dashboard" className="mb-4 flex items-center gap-2 px-3 py-2">
          <BrandLockup name={t("app.name")} size="md" />
        </Link>
        <SideNav platformAdmin={platformAdmin} />
        <p className="mt-auto px-3 pt-4 text-[11px] text-slate-400">{t("app.tagline")}</p>
      </aside>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
          <Link href="/dashboard" className="flex items-center gap-2 md:hidden">
            <BrandLockup name={t("app.name")} size="sm" />
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <CompanySwitcher tenantId={auth.tenantId} platformAdmin={platformAdmin} />
            <LocaleSwitcher compact />
            <UserMenu displayName={displayName} />
          </div>
        </header>
        {auth.mode === "clerk" ? <AdminModeSwitch /> : null}
        {auth.tenantId ? <ReminderReviewAlert key={auth.tenantId} tenantId={auth.tenantId} /> : null}
        <OfflineIndicator />
        <main className="flex-1 px-4 pb-24 pt-5 md:px-8 md:pb-10">
          {platformAdmin && !auth.tenantId ? <Link href="/platform" className="mb-4 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Select a company to continue with platform administration.</Link> : null}
          {children}
        </main>
        {/* Signature de l'éditeur, discrète et présente sur chaque écran. */}
        <footer className="px-4 pb-24 text-center text-xs text-slate-400 md:px-8 md:pb-6 dark:text-slate-600">{t("brand.signature")}</footer>
      </div>
      <BottomNav />
    </div>
  );
}
