// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { useRef, useTransition } from "react";
import { useT } from "@/lib/i18n-client";
import { resetOfflineServices } from "@/lib/offline-browser";
import { Button } from "@/components/ui/Button";

export function UserMenu({ displayName, platformAdmin = false }: { displayName: string; platformAdmin?: boolean }) {
  const t = useT();
  const { signOut } = useClerk();
  const [pending, start] = useTransition();
  const menu = useRef<HTMLDetailsElement>(null);
  const logout = () =>
    start(async () => {
      await fetch("/api/session/logout", { method: "POST" }).catch(() => undefined);
      resetOfflineServices();
    try { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } catch { void 0; }
    if (process.env.NEXT_PUBLIC_AUTH_MODE !== "dev") await signOut({ redirectUrl: "/login" });
    else window.location.replace("/login");
    });
  return (
    <div className="flex items-center gap-2">
      <details ref={menu} className="relative">
        <summary className="cursor-pointer rounded-lg px-2 py-1.5 text-xs font-medium text-slate-700 focus-visible:outline dark:text-slate-200">Compte</summary>
        <nav aria-label="Menu du compte" onClick={(event) => { if ((event.target as HTMLElement).closest("a") && menu.current) menu.current.open = false; }} className="user-menu-panel absolute right-0 top-full z-50 mt-2 w-60 rounded-xl border border-slate-200 bg-[#F7F5F0] p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <Link href="/account" className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">Mon compte</Link>
          <Link href="/account/security" className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">Sécurité · double authentification</Link>
          {platformAdmin && <Link href="/platform" className="block rounded-lg px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-amber-950/30">Vue d’ensemble admin</Link>}
          {platformAdmin && <Link href="/platform/ai" className="block rounded-lg px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-amber-950/30">Fournisseurs IA</Link>}
          <Button variant="ghost" size="sm" className="mt-1 w-full justify-start border-t border-slate-200 px-3 py-3 dark:border-slate-700" onClick={logout} disabled={pending}>{pending ? "Déconnexion…" : t("common.logout")}</Button>
        </nav>
      </details>
      <span className="hidden max-w-[10rem] truncate text-xs text-slate-500 sm:inline" title={displayName}>
        {displayName}
      </span>
    </div>
  );
}
