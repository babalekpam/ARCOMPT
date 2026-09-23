// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { z } from "zod";

/**
 * Sorties JSON strictes de la couche IA. Tout ce qui sort du modèle est
 * validé par ces schémas avant d'atteindre un module métier.
 */
const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "montant décimal (4 décimales max)");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Capture de pièce : le modèle vision lit une facture ou un reçu. */
export const DocumentExtractionSchema = z.object({
  document_type: z.enum(["INVOICE", "RECEIPT", "BANK_STATEMENT", "PAYSLIP", "OTHER"]),
  supplier_name: z.string().nullable(),
  supplier_tax_id: z.string().nullable(),
  customer_name: z.string().nullable(),
  reference: z.string().nullable(),
  date: isoDate.nullable(),
  currency: z.string().length(3).nullable(),
  amount_excl_tax: money.nullable(),
  vat_amount: money.nullable(),
  amount_incl_tax: money.nullable(),
  lines: z
    .array(z.object({ description: z.string(), quantity: money.nullable(), unit_price: money.nullable(), amount: money.nullable() }))
    .default([]),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});
export type DocumentExtraction = z.infer<typeof DocumentExtractionSchema>;

/** Proposition d'écriture : jamais comptabilisée sans validation humaine. */
export const EntryProposalSchema = z.object({
  journal_code: z.string(),
  date: isoDate,
  label: z.string().min(1),
  lines: z
    .array(
      z.object({
        account_number: z.string().regex(/^[1-9]\d{1,12}$/),
        debit: money.optional(),
        credit: money.optional(),
        label: z.string().optional(),
        vat_code: z.string().optional(),
      }),
    )
    .min(2),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  alternatives: z.array(z.object({ account_number: z.string(), rationale: z.string() })).default([]),
});
export type EntryProposal = z.infer<typeof EntryProposalSchema>;

/** Catégorisation : compte proposé pour une dépense ou un encaissement. */
export const CategorizationSchema = z.object({
  account_number: z.string().regex(/^[1-9]\d{1,12}$/),
  vat_code: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type Categorization = z.infer<typeof CategorizationSchema>;

/** Assistant : le modèle ne produit jamais de SQL, il appelle des outils typés en lecture seule. */
export const AssistantToolCallSchema = z.object({
  tool: z.enum(["get_aged_receivables", "get_aged_payables", "get_cash_position", "get_trial_balance", "get_vat_summary", "explain_statement_line"]),
  arguments: z.record(z.unknown()),
});
export type AssistantToolCall = z.infer<typeof AssistantToolCallSchema>;
