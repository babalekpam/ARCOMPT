// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * @arcompt/payroll — paie pilotée par le pack pays.
 *
 * - `computePayslip` : calcul pur d'un bulletin depuis les règles du pack ;
 * - `derivePayrollScheme` : cotisations, impôt et comptes découverts par convention ;
 * - `PayrollService` : salariés (chiffrés au repos), cycles, écritures, livre de paie, déclarations ;
 * - `PayrollCrypto` : AES-256-GCM pour les champs sensibles.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./crypto.js";
export * from "./scheme.js";
export * from "./compute.js";
export * from "./service.js";
