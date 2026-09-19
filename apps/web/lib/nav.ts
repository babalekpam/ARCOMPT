/** Navigation de l'application : sections disponibles et modules à venir. */
export interface NavItem {
  href: string;
  labelKey: string;
  icon: string;
  soon?: boolean;
}

export const MAIN_NAV: NavItem[] = [
  { href: "/", labelKey: "nav.dashboard", icon: "▦" },
  { href: "/entries", labelKey: "nav.entries", icon: "✎" },
  { href: "/balance", labelKey: "nav.ledger", icon: "☰" },
  { href: "/statements", labelKey: "nav.statements", icon: "▤" },
  { href: "/accounts", labelKey: "nav.accounts", icon: "⌗" },
  { href: "/settings", labelKey: "nav.settings", icon: "⚙" },
];

export const SOON_NAV: NavItem[] = [
  { href: "/soon/invoices", labelKey: "nav.invoices", icon: "▣", soon: true },
  { href: "/soon/expenses", labelKey: "nav.expenses", icon: "▧", soon: true },
  { href: "/soon/treasury", labelKey: "nav.treasury", icon: "◈", soon: true },
  { href: "/soon/payroll", labelKey: "nav.payroll", icon: "☺", soon: true },
  { href: "/soon/tax", labelKey: "nav.tax", icon: "％", soon: true },
  { href: "/soon/documents", labelKey: "nav.documents", icon: "✦", soon: true },
  { href: "/soon/firm", labelKey: "nav.firm", icon: "◫", soon: true },
];

/** Éléments de la barre inférieure sur mobile (4 + « Plus »). */
export const BOTTOM_NAV: NavItem[] = MAIN_NAV.slice(0, 4);

export const SOON_MODULES: Record<string, string> = {
  invoices: "nav.invoices",
  expenses: "nav.expenses",
  treasury: "nav.treasury",
  payroll: "nav.payroll",
  tax: "nav.tax",
  documents: "nav.documents",
  firm: "nav.firm",
};

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
