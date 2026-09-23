// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { config } from "./config";

/** Exercice courant depuis les paramètres d'URL (`fy`, `prev`) avec repli sur la configuration. */
export function resolveFiscalYear(searchParams: Record<string, string | string[] | undefined>): { fiscalYear: string; previousFiscalYear: string | undefined } {
  const fy = typeof searchParams.fy === "string" && /^\d{4}(-\d+)?$/.test(searchParams.fy) ? searchParams.fy : config.defaultFiscalYear();
  const prev = typeof searchParams.prev === "string" && /^\d{4}(-\d+)?$/.test(searchParams.prev) ? searchParams.prev : undefined;
  return { fiscalYear: fy, previousFiscalYear: prev };
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
