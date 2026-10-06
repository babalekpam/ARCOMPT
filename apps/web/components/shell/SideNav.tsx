// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n-client";
import { isActivePath, MAIN_NAV, SOON_NAV, type NavItem } from "@/lib/nav";
import { isPlatformPath, PlatformNav } from "./PlatformNav";

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useT();
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
        active ? "bg-[#0E9F6E] text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
      } ${item.soon ? "opacity-70" : ""}`}
    >
      <span className="w-5 text-center" aria-hidden>
        {item.icon}
      </span>
      <span className="flex-1 truncate">{t(item.labelKey)}</span>
      {item.soon ? <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase text-slate-600 dark:bg-slate-700 dark:text-slate-300">{t("nav.comingSoon")}</span> : null}
    </Link>
  );
}

/** Barre latérale (desktop) : sections disponibles puis modules à venir. */
export function SideNav({ platformAdmin = false }: { platformAdmin?: boolean }) {
  const pathname = usePathname();
  const t = useT();
  if (platformAdmin && isPlatformPath(pathname)) return <PlatformNav />;
  return (
    <nav aria-label="Navigation principale" className="flex flex-col gap-1">
      <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t("nav.sectionMain")}</p>
      {MAIN_NAV.map((item) => (
        <NavLink key={item.href} item={item} active={isActivePath(pathname, item.href)} />
      ))}
      <Link href="/account/security" aria-current={pathname === "/account/security" ? "page" : undefined} className="mt-3 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">Sécurité du compte</Link>
      {platformAdmin ? <Link href="/platform" aria-current={pathname === "/platform" ? "page" : undefined} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-amber-950/30"><span>Vue d’ensemble admin</span></Link> : null}
      {platformAdmin ? <Link href="/platform/ai" aria-current={isActivePath(pathname, "/platform/ai") ? "page" : undefined} className={`rounded-lg px-3 py-2 text-sm text-amber-800 dark:text-amber-200 ${isActivePath(pathname, "/platform/ai") ? "bg-amber-50 font-semibold dark:bg-amber-950/30" : "hover:bg-amber-50 dark:hover:bg-amber-950/30"}`}>Fournisseurs IA</Link> : null}
      <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t("nav.sectionSoon")}</p>
      {SOON_NAV.map((item) => (
        <NavLink key={item.href} item={item} active={isActivePath(pathname, item.href)} />
      ))}
    </nav>
  );
}
