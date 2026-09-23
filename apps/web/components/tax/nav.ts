// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { SubNavItem } from "@/components/payroll/SubNav";

export const TAX_NAV: SubNavItem[] = [
  { href: "/tax", labelKey: "tax.nav.vat" },
  { href: "/tax/is/instalments", labelKey: "tax.nav.is" },
  { href: "/tax/withholding", labelKey: "tax.nav.withholding" },
  { href: "/tax/dsf", labelKey: "tax.nav.dsf" },
  { href: "/tax/calendar", labelKey: "tax.nav.calendar" },
];
