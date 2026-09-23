// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n-client";
import { FIRM_TAB_HREF, FIRM_TABS } from "./helpers";

/** Onglets du portail cabinet. */
export function FirmNav() {
  const pathname = usePathname();
  const t = useT();
  return (
    <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Cabinet">
      {FIRM_TABS.map((tab) => {
        const href = FIRM_TAB_HREF[tab];
        const active = href === "/firm" ? pathname === "/firm" : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={tab} href={href} aria-current={active ? "page" : undefined} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${active ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
            {t(`firm.tab.${tab}`)}
          </Link>
        );
      })}
    </nav>
  );
}
