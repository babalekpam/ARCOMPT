// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Configuration lue depuis l'environnement (côté serveur uniquement, sauf les
 * variables NEXT_PUBLIC_*). Les valeurs par défaut correspondent au démarrage
 * local (`pnpm dev`).
 */
export type AuthMode = "dev" | "clerk";

export const config = {
  /** URL de l'API vue depuis le serveur Next (route handlers, composants serveur). */
  apiUrl: () => process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  /** AUTH_MODE=dev is local-only; production must explicitly select Clerk. */
  authMode: (): AuthMode => {
    const value = process.env.AUTH_MODE;
    if (value === "dev" && process.env.NODE_ENV !== "production") return "dev";
    if (value === "clerk") return "clerk";
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_MODE must be explicitly set to clerk in production");
    }
    return "dev";
  },
  authSecret: () => process.env.AUTH_SECRET ?? process.env.SESSION_SECRET ?? process.env.NEXTAUTH_SECRET,
  defaultLocale: () => (process.env.DEFAULT_LOCALE === "en" ? "en" : "fr"),
  /** Exercice affiché par défaut (l'API n'expose pas encore la liste des exercices). */
  defaultFiscalYear: () => process.env.DEFAULT_FISCAL_YEAR ?? String(new Date().getFullYear()),
  defaultCurrency: () => process.env.DEFAULT_CURRENCY ?? "XOF",
} as const;

/** Noms des cookies de session applicative (httpOnly côté serveur). */
export const COOKIES = {
  dev: "arcompt_dev",
  tenant: "arcompt_tenant",
  locale: "arcompt_locale",
  mfa: "arcompt_mfa",
  adminMode: "arcompt_admin_mode",
  customerTenant: "arcompt_customer_tenant",
} as const;
