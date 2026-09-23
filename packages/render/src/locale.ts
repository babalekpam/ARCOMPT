// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Locale } from "./views.js";

/**
 * D'où vient la langue d'un document produit.
 *
 * La plateforme a quatre sources possibles, qui ne disent pas la même chose :
 *
 *  - la demande explicite (« éditer cette facture en anglais ») ;
 *  - le destinataire : le client, le fournisseur ou le salarié QUI LIRA la
 *    pièce ;
 *  - le dossier (`company`) : la langue de tenue du dossier, celle sous
 *    laquelle il est archivé et déposé ;
 *  - l'opérateur (`app_user.locale`) : la langue de travail du comptable.
 *
 * L'ordre ci-dessous les range du plus proche du lecteur au plus lointain. Il
 * tient en une phrase : **un document parle la langue de celui qui le lit, pas
 * celle de celui qui le produit.** Une facture adressée à un client
 * anglophone sort en anglais même quand le comptable travaille en français ;
 * une balance générale, que personne n'adresse à un tiers, sort dans la langue
 * du dossier, parce que c'est celle sous laquelle le dossier est déposé — et
 * non celle de l'écran du comptable, qui peut changer d'un jour à l'autre.
 *
 * L'opérateur passe donc en dernier, juste avant le défaut. Il ne sert qu'à
 * départager un document sans destinataire dans un dossier dont la langue
 * n'est pas renseignée.
 */

export const LOCALES: readonly Locale[] = ["fr", "en"] as const;

/**
 * Langue par défaut, explicite : le SYSCOHADA est un référentiel francophone
 * et un dossier dont personne n'a renseigné la langue est un dossier français.
 * C'est un choix, pas un hasard : le repli ne doit jamais dépendre de la
 * locale du serveur.
 */
export const DEFAULT_LOCALE: Locale = "fr";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * « en-GB », « FR_fr », « fr-CI » → « en », « fr ». Toute autre valeur (langue
 * non gérée, chaîne vide, null) donne `undefined`, ce qui laisse la source
 * suivante décider au lieu d'imposer un repli trop tôt.
 */
export function normalizeLocale(value: string | null | undefined): Locale | undefined {
  if (typeof value !== "string") return undefined;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : undefined;
}

/** Les quatre sources, de la plus proche du lecteur à la plus lointaine. */
export interface LocaleSources {
  /** Demande explicite à la génération (paramètre de requête, choix d'écran). */
  requested?: string | null | undefined;
  /** Langue du destinataire : tiers facturé, salarié, invité. */
  recipient?: string | null | undefined;
  /** Langue de tenue du dossier (`company`). */
  company?: string | null | undefined;
  /** Langue de l'opérateur (`app_user.locale`). */
  user?: string | null | undefined;
  /** Repli final ; `DEFAULT_LOCALE` si absent. */
  fallback?: Locale | undefined;
}

/**
 * Applique la précédence : demande explicite → destinataire → dossier →
 * opérateur → défaut. Une source absente ou illisible est simplement sautée.
 */
export function resolveLocale(sources: LocaleSources = {}): Locale {
  return (
    normalizeLocale(sources.requested) ??
    normalizeLocale(sources.recipient) ??
    normalizeLocale(sources.company) ??
    normalizeLocale(sources.user) ??
    sources.fallback ??
    DEFAULT_LOCALE
  );
}
