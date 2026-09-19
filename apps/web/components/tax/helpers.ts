/** Aides pures du module fiscalité (testables sans React ni réseau). */
import type { BadgeTone } from "@/components/ui/Badge";
import type { DeadlineStatus, IsComputation, TaxReturnStatus, VatReturnComputation } from "./types";

export function deadlineTone(status: DeadlineStatus): BadgeTone {
  switch (status) {
    case "DONE":
      return "success";
    case "OVERDUE":
      return "danger";
    case "DUE_SOON":
      return "warning";
    default:
      return "info";
  }
}

export function returnTone(status: TaxReturnStatus): BadgeTone {
  switch (status) {
    case "FILED":
      return "success";
    case "VALIDATED":
      return "success";
    case "COMPUTED":
      return "info";
    default:
      return "neutral";
  }
}

const isString = (v: unknown): v is string => typeof v === "string";
const isCodeAmount = (v: unknown): v is VatReturnComputation["collected"][number] => typeof v === "object" && v !== null && isString((v as { vatCode?: unknown }).vatCode) && isString((v as { amount?: unknown }).amount);

/** Relit le détail de calcul stocké dans `taxReturn.data` ; null si la forme n'est pas celle attendue. */
export function parseVatComputation(data: Record<string, unknown> | null | undefined): VatReturnComputation | null {
  if (!data) return null;
  const { collected, deductible, totalCollected, totalDeductible, net, previousCredit, amountDue, creditCarried, periodFrom, periodTo } = data;
  if (!Array.isArray(collected) || !Array.isArray(deductible) || !collected.every(isCodeAmount) || !deductible.every(isCodeAmount)) return null;
  if (![totalCollected, totalDeductible, net, previousCredit, amountDue, creditCarried].every(isString)) return null;
  return {
    periodFrom: isString(periodFrom) ? periodFrom : "",
    periodTo: isString(periodTo) ? periodTo : "",
    collected,
    deductible,
    totalCollected: totalCollected as string,
    totalDeductible: totalDeductible as string,
    net: net as string,
    previousCredit: previousCredit as string,
    amountDue: amountDue as string,
    creditCarried: creditCarried as string,
  };
}

export function parseIsComputation(data: Record<string, unknown> | null | undefined): IsComputation | null {
  if (!data) return null;
  const { fiscalResult, turnover, isAmount, imfAmount, due, instalments } = data;
  if (![fiscalResult, turnover, isAmount, imfAmount, due].every(isString) || !Array.isArray(instalments)) return null;
  const list = instalments.filter((i): i is IsComputation["instalments"][number] => typeof i === "object" && i !== null && typeof (i as { n?: unknown }).n === "number" && isString((i as { amount?: unknown }).amount));
  return { fiscalResult: fiscalResult as string, turnover: turnover as string, isAmount: isAmount as string, imfAmount: imfAmount as string, due: due as string, instalments: list.map((i) => ({ n: i.n, amount: i.amount, dueDate: isString(i.dueDate) ? i.dueDate : null })) };
}

export interface DsfParams {
  reintegrations: string;
  deductions: string;
  previousFiscalYear?: string | undefined;
}

/** Chaîne de requête des routes DSF (JSON et Excel) ; les valeurs vides sont omises. */
export function dsfQuery(p: DsfParams): string {
  const qs = new URLSearchParams();
  if (p.reintegrations && p.reintegrations !== "0") qs.set("reintegrations", p.reintegrations);
  if (p.deductions && p.deductions !== "0") qs.set("deductions", p.deductions);
  if (p.previousFiscalYear) qs.set("previousFiscalYear", p.previousFiscalYear);
  return qs.toString();
}

/** Lien de téléchargement du classeur DSF via le proxy authentifié. */
export function dsfExportHref(fiscalYear: string, p: DsfParams): string {
  const qs = dsfQuery(p);
  return `/api/proxy/tax/dsf/${encodeURIComponent(fiscalYear)}.xlsx${qs ? `?${qs}` : ""}`;
}

/** Bornes par défaut d'un registre : 1er janvier de l'année → aujourd'hui. */
export function defaultRange(today: Date): { from: string; to: string } {
  const iso = today.toISOString().slice(0, 10);
  return { from: `${iso.slice(0, 4)}-01-01`, to: iso };
}

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
