// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n-client";

const TABS = [
  { href: "/documents", key: "documents.tab.list" },
  { href: "/documents/upload", key: "documents.tab.upload" },
  { href: "/documents/review", key: "documents.tab.review" },
  { href: "/documents/anomalies", key: "documents.tab.anomalies" },
  { href: "/assistant", key: "documents.tab.assistant" },
];

/** Sous-navigation du module pièces & IA. */
export function DocumentsNav() {
  const pathname = usePathname();
  const t = useT();
  return (
    <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label={t("documents.nav.label")}>
      {TABS.map((tab) => {
        const active = tab.href === "/documents" ? pathname === "/documents" || /^\/documents\/[0-9a-f-]{36}$/i.test(pathname) : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${active ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
