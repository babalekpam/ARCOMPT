// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/** Navigation de l'application : sections disponibles et modules à venir. */
export interface NavItem {
  href: string;
  labelKey: string;
  icon: string;
  soon?: boolean;
}

export const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "nav.dashboard", icon: "▦" },
  { href: "/entries", labelKey: "nav.entries", icon: "✎" },
  { href: "/invoices", labelKey: "nav.invoices", icon: "▣" },
  { href: "/payments", labelKey: "nav.payments", icon: "¤" },
  { href: "/expenses", labelKey: "nav.expenses", icon: "▧" },
  { href: "/treasury", labelKey: "nav.treasury", icon: "◈" },
  { href: "/payroll", labelKey: "nav.payroll", icon: "☺" },
  { href: "/tax", labelKey: "nav.tax", icon: "％" },
  { href: "/assets", labelKey: "nav.assets", icon: "▥" },
  { href: "/closing", labelKey: "nav.closing", icon: "✔" },
  { href: "/documents", labelKey: "nav.documents", icon: "✦" },
  { href: "/balance", labelKey: "nav.ledger", icon: "☰" },
  { href: "/statements", labelKey: "nav.statements", icon: "▤" },
  { href: "/accounts", labelKey: "nav.accounts", icon: "⌗" },
  { href: "/firm", labelKey: "nav.firm", icon: "◫" },
  { href: "/firm/members", labelKey: "nav.invitations", icon: "✉" },
  { href: "/sync", labelKey: "nav.sync", icon: "⟳" },
  { href: "/operations/jobs", labelKey: "nav.operations", icon: "OP" },
  { href: "/settings", labelKey: "nav.settings", icon: "⚙" },
];

/** Modules non encore livrés (aucun à ce stade ; conservé pour les phases suivantes). */
export const SOON_NAV: NavItem[] = [];

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
  // The invitations screen has its own main-nav entry; don't highlight Cabinet twice.
  if (href === "/firm" && (pathname === "/firm/members" || pathname.startsWith("/firm/members/"))) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
