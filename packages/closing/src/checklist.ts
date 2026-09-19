import type { ChecklistItem, ChecklistScope, ChecklistTemplateItem } from "./types.js";

/** Liste de contrôle mensuelle. */
export const MONTHLY_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "bank_reconciled", label: "Rapprochements bancaires faits (banque, caisse, mobile money)", blocking: true },
  { key: "lettrage_401_411", label: "Lettrage des comptes 401 fournisseurs et 411 clients", blocking: false },
  { key: "vat_declared", label: "TVA de la période déclarée", blocking: true },
  { key: "cash_counted", label: "Caisse comptée et rapprochée du compte 57", blocking: true },
  { key: "suspense_471_cleared", label: "Compte d'attente 471 soldé", blocking: true },
  { key: "missing_documents", label: "Pièces manquantes réclamées ou obtenues", blocking: false },
];

/** Liste de contrôle annuelle (en plus de la liste mensuelle du dernier mois). */
export const ANNUAL_CHECKLIST: ChecklistTemplateItem[] = [
  { key: "depreciation", label: "Dotations aux amortissements passées (module immobilisations)", blocking: true },
  { key: "provisions", label: "Provisions et dépréciations (clients douteux, risques, stocks) revues", blocking: true },
  { key: "accruals_476_477", label: "Charges et produits constatés d'avance (476 / 477) et à payer / à recevoir", blocking: true },
  { key: "inventory", label: "Inventaire physique des stocks et variation comptabilisée", blocking: true },
  { key: "income_tax", label: "Impôt sur le résultat (IS / IMF) calculé et comptabilisé", blocking: true },
  { key: "equity_auscgie", label: "Capitaux propres ≥ moitié du capital (AUSCGIE), sinon procédure engagée", blocking: false },
];

export function checklistTemplate(scope: ChecklistScope): ChecklistTemplateItem[] {
  return scope === "MONTHLY" ? MONTHLY_CHECKLIST : ANNUAL_CHECKLIST;
}

/** Items bloquants encore à faire. */
export function openBlockingItems<T extends Pick<ChecklistItem, "blocking" | "status">>(items: T[]): T[] {
  return items.filter((i) => i.blocking && i.status === "TODO");
}

/** Une liste autorise la clôture si aucun item bloquant n'est TODO (les items NA sont acceptés). */
export function checklistAllowsClose<T extends Pick<ChecklistItem, "blocking" | "status">>(items: T[]): { ok: boolean; blocking: T[] } {
  const blocking = openBlockingItems(items);
  return { ok: blocking.length === 0, blocking };
}

/** Avancement en pourcentage (items DONE ou NA sur le total). */
export function checklistProgress<T extends Pick<ChecklistItem, "status">>(items: T[]): number {
  if (items.length === 0) return 0;
  return Math.round((items.filter((i) => i.status !== "TODO").length / items.length) * 100);
}
