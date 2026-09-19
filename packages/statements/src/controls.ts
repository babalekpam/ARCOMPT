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

  const eq = (id: string, label: string, severity: Control["severity"], a: Money, b: Money, detail: string): void => {
    out.push({ id, label, severity, ok: a.eq(b), detail, expected: b.toString(), actual: a.toString() });
  };

  // Équilibre de la balance elle-même.
  let totalD = Money.zero();
  let totalC = Money.zero();
  for (const v of ctx.current.values()) {
    totalD = totalD.add(v.debit);
    totalC = totalC.add(v.credit);
  }
  eq("BALANCE_EQUILIBREE", "Balance équilibrée (total débits = total crédits)", "BLOCKING", totalD, totalC, "La balance de clôture doit être équilibrée avant tout calcul.");

  if (actif && passif) {
    eq("ACTIF_EGAL_PASSIF", "Total actif = total passif", "BLOCKING", actif.byCode.BZ!.net, passif.byCode.DZ!.net, "Le total général de l'actif (BZ) doit être égal à celui du passif (DZ).");
  }
  if (passif && cr) {
    eq("RESULTAT_BILAN_CR", "Résultat du bilan = résultat du compte de résultat", "BLOCKING", passif.byCode.CJ!.net, cr.byCode.XI!.net, "Le poste CJ du passif doit reprendre le résultat net XI. Après affectation du résultat (compte 13), XI est nul : produisez les états avant l'affectation.");
  }
  if (tft && ctx.hasPrevious) {
    const za = tft.byCode.ZA!.net;
    const zg = tft.byCode.ZG!.net;
    const zh = tft.byCode.ZH!.net;
    eq("TFT_VARIATION_TRESORERIE", "Variation de trésorerie du TFT = trésorerie nette N − trésorerie nette N-1", "BLOCKING", za.add(zg), zh, "ZA + ZG doit être égal à ZH. Un écart révèle un compte de bilan non repris par un flux ou un mouvement atypique à retraiter.");
  } else if (tft) {
    out.push({ id: "TFT_VARIATION_TRESORERIE", label: "Tableau des flux : balance N-1 absente", severity: "WARNING", ok: false, detail: "Sans balance N-1, le TFT et la colonne N-1 ne peuvent pas être produits." });
  }

  out.push({
    id: "AUCUN_SOLDE_ORPHELIN",
    label: "Chaque compte mouvementé est rattaché à un poste",
    severity: "BLOCKING",
    ok: ctx.orphanAccounts.length === 0,
    detail: ctx.orphanAccounts.length === 0 ? "Tous les comptes des classes 1 à 8 sont repris par un poste." : `Comptes sans poste : ${ctx.orphanAccounts.join(", ")}`,
  });

  for (const n of ctx.notes) {
    if (n.reconciles) {
      eq(`NOTE_${n.number}_RAPPROCHEE`, `Note ${n.number} : total = poste ${n.reconciles.code}`, "BLOCKING", n.total, n.reconciles.expected, `Le total de la note ${n.number} doit être égal au poste ${n.reconciles.code} de l'état.`);
    }
  }

  // Alertes non bloquantes.
  const caisseCreditrice = evalFormula(["+57:C"], ctx.current, ctx.previous).amount;
  out.push({ id: "CAISSE_CREDITRICE", label: "Caisse créditrice", severity: "WARNING", ok: caisseCreditrice.isZero(), detail: caisseCreditrice.isZero() ? "Aucune caisse créditrice." : `Une caisse présente un solde créditeur de ${caisseCreditrice} : impossible physiquement, vérifiez les encaissements.` });
  const attente = evalFormula(["+471"], ctx.current, ctx.previous).amount;
  out.push({ id: "COMPTE_ATTENTE_SOLDE", label: "Compte d'attente 471 soldé", severity: "WARNING", ok: attente.isZero(), detail: attente.isZero() ? "Le compte d'attente est soldé." : `Le compte 471 présente un solde de ${attente} : à imputer avant clôture.` });
  const tva = evalFormula(["+443:D", "+445:C"], ctx.current, ctx.previous).amount;
  out.push({ id: "TVA_SENS", label: "Sens des comptes de TVA", severity: "WARNING", ok: tva.isZero(), detail: tva.isZero() ? "TVA facturée créditrice, TVA récupérable débitrice." : "Un compte de TVA présente un sens inhabituel (443 débiteur ou 445 créditeur)." });
  if (passif) {
    const capital = passif.byCode.CA!.net;
    const capitauxPropres = passif.byCode.CP!.net;
    const half = capital.mulRate("0.5");
    const ok = capital.isZero() || capitauxPropres.cmp(half) >= 0;
    out.push({ id: "CAPITAUX_PROPRES_AUSCGIE", label: "Capitaux propres ≥ moitié du capital (AUSCGIE)", severity: "WARNING", ok, detail: ok ? "Aucune perte de la moitié du capital." : `Les capitaux propres (${capitauxPropres}) sont inférieurs à la moitié du capital social (${half}) : procédure AUSCGIE de dissolution anticipée à examiner.` });
  }
  if (ctx.system === "SMT") {
    out.push({ id: "SMT_PERIMETRE", label: "Système minimal de trésorerie", severity: "WARNING", ok: true, detail: "États produits en présentation simplifiée ; pas de tableau des flux." });
  }
  return out;
}
