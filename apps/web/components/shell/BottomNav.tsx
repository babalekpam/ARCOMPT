// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n-client";
import { BOTTOM_NAV, isActivePath, MAIN_NAV, SOON_NAV } from "@/lib/nav";
import { isPlatformPath, PlatformNav } from "./PlatformNav";

/** Barre de navigation inférieure (mobile) : quatre sections + menu « Plus ». */
export function BottomNav({ platformAdmin = false }: { platformAdmin?: boolean }) {
  const pathname = usePathname();
  const t = useT();
  const [moreOpen, setMoreOpen] = useState(false);
  if (platformAdmin && isPlatformPath(pathname)) return <PlatformNav mobile />;
  const more = [...MAIN_NAV.slice(4), ...SOON_NAV];
  const moreActive = more.some((i) => isActivePath(pathname, i.href)) || pathname === "/account/security" || (platformAdmin && isActivePath(pathname, "/platform"));
  return (
    <>
      {moreOpen ? (
        <div className="fixed inset-0 z-30 bg-slate-900/40 md:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-x-0 bottom-16 rounded-t-2xl bg-white p-3 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <ul className="grid grid-cols-2 gap-1">
              <li><Link href="/account/security" onClick={() => setMoreOpen(false)} className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">Sécurité du compte</Link></li>
              {platformAdmin && <li><Link href="/platform" onClick={() => setMoreOpen(false)} className="block rounded-lg px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-amber-950/30">Vue d’ensemble admin</Link></li>}
              {platformAdmin && <li><Link href="/platform/ai" aria-current={isActivePath(pathname, "/platform/ai") ? "page" : undefined} onClick={() => setMoreOpen(false)} className="block rounded-lg px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-amber-950/30">Fournisseurs IA</Link></li>}
              {more.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} onClick={() => setMoreOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
                    <span aria-hidden>{item.icon}</span>
                    <span className="truncate">{t(item.labelKey)}</span>
                    {item.soon ? <span className="ml-auto text-[10px] uppercase text-slate-400">{t("nav.comingSoon")}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <nav aria-label="Navigation mobile" className="fixed inset-x-0 bottom-0 z-40 grid h-16 grid-cols-5 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-900/95" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {BOTTOM_NAV.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`flex flex-col items-center justify-center gap-0.5 text-[11px] ${active ? "text-[#0E9F6E] dark:text-white" : "text-slate-500"}`}>
              <span className="text-lg leading-none" aria-hidden>
                {item.icon}
              </span>
              <span className="truncate px-1">{t(item.labelKey)}</span>
            </Link>
          );
        })}
        <button type="button" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen} className={`flex flex-col items-center justify-center gap-0.5 text-[11px] ${moreActive || moreOpen ? "text-[#0E9F6E] dark:text-white" : "text-slate-500"}`}>
          <span className="text-lg leading-none" aria-hidden>
            ⋯
          </span>
          <span>{t("nav.more")}</span>
        </button>
      </nav>
    </>
  );
}
