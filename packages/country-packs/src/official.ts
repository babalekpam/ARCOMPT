/**
 * Garde des documents légaux produits à partir d'un pack pays.
 *
 * `docs/country-packs/README.md` pose la règle depuis l'origine : « Un pack en
 * DRAFT ne doit jamais servir à produire une déclaration réelle. » Elle n'était
 * écrite qu'en prose. Ce module la rend exécutable.
 *
 * Deux régimes, et un seul critère pour trancher : **ce qui sort de
 * l'entreprise comme document légal**.
 *
 *  - Tenue, facturation, écritures, balance, états financiers à l'écran : rien
 *    n'est refusé. Une PME qui essaie le produit doit pouvoir tenir sa
 *    comptabilité sur un pack en cours de rédaction — les états financiers ne
 *    dépendent d'ailleurs d'aucun pack, ils viennent du grand livre.
 *  - Déclaration validée ou déposée, acomptes d'IS, liasse DSF et son classeur,
 *    déclarations sociales, dépôt préparé : refus net tant que le pack n'est pas
 *    PUBLISHED, avec le nom du pack, son statut et ce qu'il reste à faire.
 *
 * Échappement de pré-production, dans l'esprit des `ALLOW_INSECURE_*` de
 * `apps/api/src/config.ts` : `ALLOW_INSECURE_DRAFT_PACK_FILINGS=1`, explicite,
 * fermé par défaut, greppable. Il ne rend pas le document officiel : il le
 * produit en le marquant « DOCUMENT NON OFFICIEL ».
 */

import type { CountryPack } from "./schema.js";

/** Variable d'opt-out explicite : produire un document légal depuis un pack non publié, marqué non officiel. */
export const DRAFT_PACK_FILINGS_OPT_OUT = "ALLOW_INSECURE_DRAFT_PACK_FILINGS";

/** Mention portée par tout document produit sous l'échappement. */
export const NON_OFFICIAL_MARK = "DOCUMENT NON OFFICIEL";

/** Identité minimale d'un pack : de quoi nommer le fautif dans un message d'erreur. */
export interface PackIdentity {
  code: string;
  version: string;
  status: CountryPack["status"];
  reviewedBy: string | null;
}

export function packIdentity(pack: CountryPack): PackIdentity {
  return { code: pack.code, version: pack.version, status: pack.status, reviewedBy: pack.reviewed_by ?? null };
}

/** Référence versionnée d'un pack, telle que `company.pack_version` la stocke : `ci@2025.1`. */
export function packReference(pack: CountryPack | PackIdentity): string {
  return `${pack.code}@${pack.version}`;
}

/**
 * Un pack ne fait autorité que publié ET revu : `reviewed_by` nomme
 * l'expert-comptable du pays qui a validé chaque valeur. Le chargeur refuse
 * déjà un PUBLISHED sans `reviewed_by` ; on ne s'en remet pas à lui.
 */
export function isPackPublished(pack: CountryPack | PackIdentity): boolean {
  const reviewedBy = (pack as CountryPack).reviewed_by ?? (pack as PackIdentity).reviewedBy ?? null;
  return pack.status === "PUBLISHED" && typeof reviewedBy === "string" && reviewedBy.trim().length > 0;
}

/** `1`, `true`, `yes` (insensible à la casse) ouvrent l'échappement ; tout le reste le laisse fermé. */
export function isOptOutEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Ce qu'il reste à faire pour qu'un pack fasse autorité (étape 4 du cycle de vie). */
function remediation(id: PackIdentity): string {
  const reviewed = id.reviewedBy ? `revu par ${id.reviewedBy}` : "sans reviewed_by";
  return (
    `Pack ${packReference(id)} au statut ${id.status} (${reviewed}). ` +
    "Pour qu'il fasse autorité : un expert-comptable inscrit à l'ordre du pays valide taux, barèmes, plafonds et comptes du pack, " +
    "`reviewed_by` est renseigné, puis le pack passe en REVIEWED et enfin en PUBLISHED " +
    "(docs/country-packs/README.md, « Cycle de vie »)."
  );
}

/** Refus de produire un document légal à partir d'un pack non publié. */
export class PackNotPublishedError extends Error {
  override name = "PackNotPublishedError";
  readonly code = "PACK_NOT_PUBLISHED";

  constructor(
    readonly pack: PackIdentity,
    /** Le document refusé, en clair : « déclaration de TVA », « liasse DSF »… */
    readonly artefact: string,
  ) {
    super(
      `${artefact} : refusé. ${remediation(pack)} ` +
        `Les taux et barèmes livrés sont indicatifs, ils ne peuvent pas fonder un document remis à l'administration. ` +
        `Pour éprouver le parcours complet avant publication, posez ${DRAFT_PACK_FILINGS_OPT_OUT}=1 : ` +
        `le document est alors produit et porte la mention « ${NON_OFFICIAL_MARK} ».`,
    );
  }
}

/** Résultat de la garde : le document est-il officiel, et sinon quelle mention porte-t-il. */
export interface OfficialUse {
  /** Vrai seulement si le pack est PUBLISHED et revu. */
  official: boolean;
  /** Mention à imprimer sur le document quand il n'est pas officiel ; `null` sinon. */
  notice: string | null;
  packCode: string;
  packVersion: string;
  packReference: string;
  packStatus: CountryPack["status"];
}

export interface OfficialGuardOptions {
  /** Le document concerné, en clair, pour le message de refus et la mention. */
  artefact: string;
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}

/**
 * Garde à poser devant tout document légal.
 *
 * Pack PUBLISHED et revu → document officiel.
 * Sinon, échappement posé → document produit, marqué non officiel, avertissement journalisé.
 * Sinon → `PackNotPublishedError`.
 */
export function assertPackPublished(pack: CountryPack, opts: OfficialGuardOptions): OfficialUse {
  const id = packIdentity(pack);
  const base = { packCode: pack.code, packVersion: pack.version, packReference: packReference(id), packStatus: pack.status };
  if (isPackPublished(pack)) return { official: true, notice: null, ...base };
  const env = opts.env ?? process.env;
  if (!isOptOutEnabled(env[DRAFT_PACK_FILINGS_OPT_OUT])) throw new PackNotPublishedError(id, opts.artefact);
  const notice = `${NON_OFFICIAL_MARK} — ${remediation(id)} Produit sous ${DRAFT_PACK_FILINGS_OPT_OUT}=1 : valeurs indicatives, aucune valeur déclarative.`;
  (opts.warn ?? console.warn)(`[arcompt] ${NON_OFFICIAL_MARK} : ${opts.artefact} produit depuis le pack ${packReference(id)} au statut ${id.status} (${DRAFT_PACK_FILINGS_OPT_OUT}=1).`);
  return { official: false, notice, ...base };
}

/**
 * Mention d'écran : un pack non publié ne doit pas laisser croire qu'il fait
 * autorité. `null` quand le pack est publié — rien à afficher.
 */
export function draftPackNotice(pack: CountryPack): string | null {
  if (isPackPublished(pack)) return null;
  return `Pack ${packReference(pack)} au statut ${pack.status} : taux et barèmes indicatifs, non validés par un expert-comptable du pays. Aucun document légal ne peut en être tiré.`;
}
