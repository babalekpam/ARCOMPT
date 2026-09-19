import type { SubNavItem } from "./SubNav";

export const PAYROLL_NAV: SubNavItem[] = [
  { href: "/payroll", labelKey: "payroll.nav.overview" },
  { href: "/payroll/book", labelKey: "payroll.nav.book" },
  { href: "/payroll/declarations", labelKey: "payroll.nav.declarations" },
];

/** Année / mois depuis les paramètres d'URL, avec repli sur la date du jour. */
export function resolvePeriod(sp: Record<string, string | string[] | undefined>): { year: number; month: number } {
  const now = new Date();
  const y = typeof sp.year === "string" && /^\d{4}$/.test(sp.year) ? Number(sp.year) : now.getFullYear();
  const m = typeof sp.month === "string" && /^\d{1,2}$/.test(sp.month) && Number(sp.month) >= 1 && Number(sp.month) <= 12 ? Number(sp.month) : now.getMonth() + 1;
  return { year: y, month: m };
}
