import { z } from "zod";

/**
 * Schéma d'un pack pays. Un pack = données versionnées + règles déclaratives
 * (expressions évaluées par @arcompt/rules). Jamais de code exécutable.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date ISO attendue (AAAA-MM-JJ)");
const decimal = z.union([z.string().regex(/^-?\d+(\.\d+)?$/), z.number()]);

export const BaremeSchema = z.object({
  kind: z.literal("bareme"),
  tranches: z.array(z.object({ upTo: decimal.optional(), rate: decimal })).min(1),
});

export const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/, "identifiant de règle : minuscules, chiffres, points"),
    label: z.string().optional(),
    expr: z.string().optional(),
    value: z.union([decimal, BaremeSchema]).optional(),
    valid_from: isoDate,
    valid_to: isoDate.optional(),
    depends_on: z.array(z.string()).optional(),
    source: z.string().optional(),
  })
  .refine((r) => (r.expr === undefined) !== (r.value === undefined), { message: "une règle porte soit expr, soit value" });

export const TaxIdSchema = z.object({
  code: z.string(), // NCC, NINEA, IFU, NIF…
  label: z.string(),
  pattern: z.string().optional(), // regex de format
  required: z.boolean().default(true),
});

export const VatRateSchema = z.object({
  code: z.string(), // TVA18, TVA9, EXO…
  label: z.string(),
  rate: decimal,
  /** Comptes SYSCOHADA de TVA facturée / récupérable. */
  collected_account: z.string(),
  deductible_account: z.string(),
  valid_from: isoDate,
  valid_to: isoDate.optional(),
});

export const CalendarSchema = z.object({
  id: z.string(),
  label: z.string(),
  frequency: z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]),
  /** Jour du mois (mensuel/trimestriel) ou date fixe MM-JJ (annuel). */
  due: z.string(),
  applies_to: z.array(z.string()).optional(), // régimes concernés
});

export const FilingSchema = z.object({
  id: z.string(),
  label: z.string(),
  portal: z.string().optional(),
  url: z.string().url().optional(),
  /** Format attendu par le portail : xlsx, xml, pdf… */
  format: z.enum(["XLSX", "XML", "PDF", "CSV", "MANUAL"]),
  template: z.string().optional(),
  api: z.literal(false).default(false), // aucun portail DGI n'expose d'API publique connue
});

export const CountryPackSchema = z.object({
  code: z.string().length(2).toLowerCase(),
  name: z.string(),
  version: z.string().regex(/^\d{4}\.\d+$/, "version AAAA.N"),
  status: z.enum(["DRAFT", "REVIEWED", "PUBLISHED"]).default("DRAFT"),
  reviewed_by: z.string().optional(),
  identity: z.object({
    currency: z.string().length(3),
    languages: z.array(z.string()).min(1),
    tax_ids: z.array(TaxIdSchema),
    accounting_systems: z.array(z.enum(["NORMAL", "SMT"])).min(1),
    smt_threshold_revenue: decimal.optional(),
    social_security_body: z.string().optional(),
    tax_authority: z.string().optional(),
  }),
  vat: z.object({
    rates: z.array(VatRateSchema),
    rules: z.array(RuleSchema).default([]),
  }),
  taxes: z.object({ rules: z.array(RuleSchema).default([]) }),
  payroll: z.object({ rules: z.array(RuleSchema).default([]), variables: z.array(z.string()).default([]) }),
  /** Variables d'entrée acceptées par les règles hors paie (résultat fiscal, réintégrations…). */
  variables: z.array(z.string()).default([]),
  dsf: z.object({
    label: z.string(),
    statements: z.array(z.string()).default([]),
    /** Tableaux de passage résultat comptable → fiscal (identifiants de règles). */
    adjustments: z.array(RuleSchema).default([]),
  }),
  filing: z.array(FilingSchema).default([]),
  calendar: z.array(CalendarSchema).default([]),
  chart_overrides: z
    .array(z.object({ number: z.string().regex(/^[1-9]\d{1,12}$/), label: z.string(), lettrable: z.boolean().optional() }))
    .default([]),
  certified_invoice: z
    .object({ system: z.string(), mandatory: z.boolean(), connector: z.string().optional(), since: isoDate.optional() })
    .optional(),
  notes: z.array(z.string()).default([]),
});

export type CountryPack = z.infer<typeof CountryPackSchema>;
export type Rule = z.infer<typeof RuleSchema>;
