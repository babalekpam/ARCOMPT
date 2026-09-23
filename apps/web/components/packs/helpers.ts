/**
 * Statut du pack pays, côté interface.
 *
 * Les huit packs livrés sont des brouillons : leurs taux et barèmes sont
 * indicatifs tant qu'un expert-comptable inscrit à l'ordre du pays ne les a pas
 * validés. Le serveur porte déjà la marque — `official`, `packNotice`, refus
 * `PACK_NOT_PUBLISHED` — mais l'interface n'en montrait rien.
 *
 * La règle est celle du serveur (`packages/country-packs/src/official.ts`) et
 * elle est recopiée ici, pas devinée : un pack ne fait autorité que PUBLISHED
 * **et** revu. Un `reviewed_by` vide sur un pack publié ne suffit pas.
 */
import type { BadgeTone } from "@/components/ui/Badge";
import type { CountryPack, PackSummary } from "@/lib/types";

/** Identité minimale d'un pack : de quoi le nommer et juger de son autorité. */
export interface PackRef {
  code: string;
  version: string;
  status: string;
  reviewedBy?: string | null;
}

/** Vue `/packs/:code` → identité. */
export function packRef(pack: CountryPack): PackRef {
  return { code: pack.code, version: pack.version, status: pack.status, reviewedBy: pack.reviewed_by ?? null };
}

/**
 * Vue `/packs` (liste) → identité. Le résumé ne porte pas `reviewed_by` : un
 * pack publié y est donc pris au mot, ce qui est sans conséquence puisque la
 * liste ne sert qu'à choisir un pays.
 */
export function packRefFromSummary(pack: PackSummary): PackRef {
  return { code: pack.code, version: pack.version, status: pack.status, reviewedBy: pack.status === "PUBLISHED" ? "—" : null };
}

/** Libellé affiché : « CI 2025.1 ». */
export function packLabel(pack: PackRef): string {
  return `${pack.code.toUpperCase()} ${pack.version}`;
}

/** Un pack ne fait autorité que publié ET revu. */
export function isPackPublished(pack: PackRef | null | undefined): boolean {
  if (!pack) return false;
  return pack.status === "PUBLISHED" && typeof pack.reviewedBy === "string" && pack.reviewedBy.trim().length > 0;
}

/** Ton du badge de statut, tel que l'écran Paramètres l'emploie déjà. */
export function packStatusTone(status: string): BadgeTone {
  if (status === "PUBLISHED") return "success";
  if (status === "REVIEWED") return "info";
  return "warning";
}

/**
 * Ce qu'il y a à dire d'un pack en cours de rédaction : son nom et son statut.
 *
 * `null` quand le pack fait autorité — l'écran reste alors silencieux — et
 * aussi quand le pack est introuvable : on ne sait rien, on n'invente pas une
 * alerte que l'utilisateur ne pourrait pas vérifier.
 */
export function draftPackParams(pack: PackRef | null | undefined): { pack: string; status: string } | null {
  if (!pack || isPackPublished(pack)) return null;
  return { pack: packLabel(pack), status: pack.status };
}
