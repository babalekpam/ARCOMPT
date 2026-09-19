"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n-client";

export interface SubNavItem {
  href: string;
  labelKey: string;
  /** Actif aussi sur les sous-chemins (défaut : égalité stricte du chemin). */
  prefix?: boolean;
}

/** Barre d'onglets secondaire d'un module (liens, état actif d'après l'URL). */
export function SubNav({ items }: { items: SubNavItem[] }) {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Sous-navigation">
      {items.map((item) => {
        const path = item.href.split("?")[0] ?? item.href;
        const active = item.prefix ? pathname === path || pathname.startsWith(`${path}/`) : pathname === path;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${active ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}
          >
            {t(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
