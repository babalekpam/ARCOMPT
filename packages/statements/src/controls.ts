import { Money, type AccountingSystem } from "@arcompt/ledger";
import { evalFormula, type BalanceIndex } from "./formula.js";
import type { ComputedNote, ComputedStatement, Control, StatementCode } from "./types.js";

interface Ctx {
  statements: Record<StatementCode, ComputedStatement>;
  notes: ComputedNote[];
  current: BalanceIndex;
  previous: BalanceIndex;
  hasPrevious: boolean;
  orphanAccounts: string[];
  system: AccountingSystem;
  /** Devise de présentation des états (code ISO 4217 normalisé). */
  currency: string;
  /** Devise réellement portée par la balance, si le grand livre l'a annoncée. */
  balanceCurrency?: string;
  /** Comptes dont le solde porte des fractions sous l'unité monétaire. */
  subUnitAccounts: string[];
}

/**
 * Contrôles de cohérence. Les contrôles BLOCKING empêchent la publication ;
 * les WARNING sont des alertes à examiner par le comptable.
 */
export function runControls(ctx: Ctx): Control[] {
  const out: Control[] = [];
  const actif = ctx.statements.BILAN_ACTIF;
  const passif = ctx.statements.BILAN_PASSIF;
  const cr = ctx.statements.COMPTE_RESULTAT;
  const tft = ctx.statements.TFT;

  // L'anglais accompagne chaque contrôle plutôt que d'être ajouté après coup :
  // les détails sont des phrases interpolées (montants, numéros de compte),
  // qu'aucune table de correspondance ne saurait retrouver.
  const eq = (id: string, label: string, severity: Control["severity"], a: Money, b: Money, detail: string, en?: { label: string; detail: string }): void => {
    out.push({ id, label, severity, ok: a.eq(b), detail, expected: b.toString(), actual: a.toString(), ...(en ? { labelEn: en.label, detailEn: en.detail } : {}) });
  };

  // Équilibre de la balance elle-même.
  let totalD = Money.zero();
  let totalC = Money.zero();
  for (const v of ctx.current.values()) {
    totalD = totalD.add(v.debit);
    totalC = totalC.add(v.credit);
  }
  eq("BALANCE_EQUILIBREE", "Balance équilibrée (total débits = total crédits)", "BLOCKING", totalD, totalC, "La balance de clôture doit être équilibrée avant tout calcul.", {
    label: "Trial balance in balance (total debits = total credits)",
    detail: "The closing trial balance must balance before anything is computed.",
  });

  // Devise. Les états SYSCOHADA n'ont qu'une colonne de montants : la balance
  // doit déjà être convertie dans la devise de présentation. Le contrôle n'est
  // possible que si le grand livre annonce la devise de la balance.
  if (ctx.balanceCurrency !== undefined) {
    const ok = ctx.balanceCurrency === ctx.currency;
    out.push({
      id: "DEVISE_ETATS",
      label: "Devise des états = devise de tenue du dossier",
      severity: "BLOCKING",
      ok,
      detail: ok
        ? `États présentés en ${ctx.currency}, devise de tenue du dossier.`
        : `Les états sont demandés en ${ctx.currency} alors que la balance est tenue en ${ctx.balanceCurrency} : les montants ne seraient pas convertis, seulement réétiquetés.`,
      labelEn: "Statement currency = the currency the books are kept in",
      detailEn: ok
        ? `Statements presented in ${ctx.currency}, the currency the books are kept in.`
        : `The statements are requested in ${ctx.currency} while the trial balance is kept in ${ctx.balanceCurrency}: the amounts would not be converted, only relabelled.`,
      expected: ctx.currency,
      actual: ctx.balanceCurrency,
    });
  }

  // Une devise sans sous-unité (XOF, XAF) ne peut pas porter de centimes : ils
  // viennent d'une conversion et appellent un arrondi décidé par le comptable,
  // pas subi à l'impression.
  {
    const ok = ctx.subUnitAccounts.length === 0;
    out.push({
      id: "UNITE_MONETAIRE",
      label: `Montants exprimés à l'unité du ${ctx.currency}`,
      severity: "WARNING",
      ok,
      detail: ok
        ? `Aucun solde ne descend sous l'unité monétaire du ${ctx.currency}.`
        : `Soldes plus fins que l'unité du ${ctx.currency} (résidus de conversion à arrondir) : ${ctx.subUnitAccounts.join(", ")}`,
      labelEn: `Amounts expressed in whole ${ctx.currency}`,
      detailEn: ok
        ? `No balance falls below one ${ctx.currency}.`
        : `Balances finer than one ${ctx.currency} (conversion residues to be rounded): ${ctx.subUnitAccounts.join(", ")}`,
    });
  }

  if (actif && passif) {
    eq("ACTIF_EGAL_PASSIF", "Total actif = total passif", "BLOCKING", actif.byCode.BZ!.net, passif.byCode.DZ!.net, "Le total général de l'actif (BZ) doit être égal à celui du passif (DZ).", {
      label: "Total assets = total equity and liabilities",
      detail: "The grand total of assets (BZ) must equal the grand total of equity and liabilities (DZ).",
    });
  }
  if (passif && cr) {
    eq("RESULTAT_BILAN_CR", "Résultat du bilan = résultat du compte de résultat", "BLOCKING", passif.byCode.CJ!.net, cr.byCode.XI!.net, "Le poste CJ du passif doit reprendre le résultat net XI. Après affectation du résultat (compte 13), XI est nul : produisez les états avant l'affectation.", {
      label: "Profit or loss in the balance sheet = profit or loss in the income statement",
      detail: "Line CJ of equity and liabilities must carry net profit or loss XI. Once the result has been appropriated (account 13) XI is nil: produce the statements before appropriation.",
    });
  }
  if (tft && ctx.hasPrevious) {
    const za = tft.byCode.ZA!.net;
    const zg = tft.byCode.ZG!.net;
    const zh = tft.byCode.ZH!.net;
    eq("TFT_VARIATION_TRESORERIE", "Variation de trésorerie du TFT = trésorerie nette N − trésorerie nette N-1", "BLOCKING", za.add(zg), zh, "ZA + ZG doit être égal à ZH. Un écart révèle un compte de bilan non repris par un flux ou un mouvement atypique à retraiter.", {
      label: "Cash flow movement in the statement of cash flows = net cash at year end − net cash at prior year end",
      detail: "ZA + ZG must equal ZH. A difference points to a balance sheet account no cash flow picks up, or an unusual movement to be restated.",
    });
  } else if (tft) {
    out.push({
      id: "TFT_VARIATION_TRESORERIE",
      label: "Tableau des flux : balance N-1 absente",
      severity: "WARNING",
      ok: false,
      detail: "Sans balance N-1, le TFT et la colonne N-1 ne peuvent pas être produits.",
      labelEn: "Statement of cash flows: prior year trial balance missing",
      detailEn: "Without the prior year trial balance, neither the statement of cash flows nor the comparative column can be produced.",
    });
  }

  out.push({
    id: "AUCUN_SOLDE_ORPHELIN",
    label: "Chaque compte mouvementé est rattaché à un poste",
    severity: "BLOCKING",
    ok: ctx.orphanAccounts.length === 0,
    detail: ctx.orphanAccounts.length === 0 ? "Tous les comptes des classes 1 à 8 sont repris par un poste." : `Comptes sans poste : ${ctx.orphanAccounts.join(", ")}`,
    labelEn: "Every account with movements maps to a statement line",
    detailEn: ctx.orphanAccounts.length === 0 ? "Every account in classes 1 to 8 is picked up by a statement line." : `Accounts with no statement line: ${ctx.orphanAccounts.join(", ")}`,
  });

  for (const n of ctx.notes) {
    if (n.reconciles) {
      eq(`NOTE_${n.number}_RAPPROCHEE`, `Note ${n.number} : total = poste ${n.reconciles.code}`, "BLOCKING", n.total, n.reconciles.expected, `Le total de la note ${n.number} doit être égal au poste ${n.reconciles.code} de l'état.`, {
        label: `Note ${n.number}: total = line ${n.reconciles.code}`,
        detail: `The total of note ${n.number} must equal line ${n.reconciles.code} of the statement.`,
      });
    }
  }

  // Alertes non bloquantes.
  const caisseCreditrice = evalFormula(["+57:C"], ctx.current, ctx.previous).amount;
  out.push({
    id: "CAISSE_CREDITRICE",
    label: "Caisse créditrice",
    severity: "WARNING",
    ok: caisseCreditrice.isZero(),
    detail: caisseCreditrice.isZero() ? "Aucune caisse créditrice." : `Une caisse présente un solde créditeur de ${caisseCreditrice} : impossible physiquement, vérifiez les encaissements.`,
    labelEn: "Cash on hand in credit",
    detailEn: caisseCreditrice.isZero() ? "No cash account is in credit." : `A cash account shows a credit balance of ${caisseCreditrice}: physically impossible, check the receipts.`,
  });
  const attente = evalFormula(["+471"], ctx.current, ctx.previous).amount;
  out.push({
    id: "COMPTE_ATTENTE_SOLDE",
    label: "Compte d'attente 471 soldé",
    severity: "WARNING",
    ok: attente.isZero(),
    detail: attente.isZero() ? "Le compte d'attente est soldé." : `Le compte 471 présente un solde de ${attente} : à imputer avant clôture.`,
    labelEn: "Suspense account 471 cleared",
    detailEn: attente.isZero() ? "The suspense account is cleared." : `Account 471 shows a balance of ${attente}: to be allocated before closing.`,
  });
  const tva = evalFormula(["+443:D", "+445:C"], ctx.current, ctx.previous).amount;
  out.push({
    id: "TVA_SENS",
    label: "Sens des comptes de TVA",
    severity: "WARNING",
    ok: tva.isZero(),
    detail: tva.isZero() ? "TVA facturée créditrice, TVA récupérable débitrice." : "Un compte de TVA présente un sens inhabituel (443 débiteur ou 445 créditeur).",
    labelEn: "Direction of the VAT accounts",
    detailEn: tva.isZero() ? "Output VAT in credit, input VAT in debit." : "A VAT account sits on the unusual side (443 in debit or 445 in credit).",
  });
  if (passif) {
    const capital = passif.byCode.CA!.net;
    const capitauxPropres = passif.byCode.CP!.net;
    const half = capital.mulRate("0.5");
    const ok = capital.isZero() || capitauxPropres.cmp(half) >= 0;
    out.push({
      id: "CAPITAUX_PROPRES_AUSCGIE",
      label: "Capitaux propres ≥ moitié du capital (AUSCGIE)",
      severity: "WARNING",
      ok,
      detail: ok ? "Aucune perte de la moitié du capital." : `Les capitaux propres (${capitauxPropres}) sont inférieurs à la moitié du capital social (${half}) : procédure AUSCGIE de dissolution anticipée à examiner.`,
      labelEn: "Equity ≥ half of share capital (AUSCGIE)",
      detailEn: ok
        ? "Half of the share capital has not been lost."
        : `Equity (${capitauxPropres}) has fallen below half the share capital (${half}): the AUSCGIE early dissolution procedure must be considered.`,
    });
  }
  if (ctx.system === "SMT") {
    out.push({
      id: "SMT_PERIMETRE",
      label: "Système minimal de trésorerie",
      severity: "WARNING",
      ok: true,
      detail: "États produits en présentation simplifiée ; pas de tableau des flux.",
      labelEn: "Minimum cash-basis system (SMT)",
      detailEn: "Statements produced in the simplified presentation; no statement of cash flows.",
    });
  }
  return out;
}
