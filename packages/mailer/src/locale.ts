/**
 * Langue d'un message sortant.
 *
 * ── Pourquoi ce fichier reprend `packages/render/src/locale.ts` ─────────
 *
 * Les deux paquets appliquent la MÊME règle, volontairement : un e-mail et un
 * PDF adressés au même tiers doivent partir dans la même langue. Le mailer ne
 * dépend d'aucun autre paquet de l'atelier (il n'a que `nodemailer`), et lui
 * ajouter une dépendance sur le paquet de rendu — donc sur Playwright et
 * ExcelJS — pour vingt lignes de logique serait un mauvais échange. La règle
 * est donc écrite deux fois, et chaque copie renvoie à l'autre.
 *
 * ── La règle ────────────────────────────────────────────────────────────
 *
 * Un message parle la langue de celui qui le REÇOIT, pas de celui qui
 * l'envoie. Une relance adressée à un client anglophone part en anglais même
 * quand le cabinet travaille en français, et une notification d'accès
 * administrateur part dans la langue du dirigeant notifié.
 *
 * Précédence : demande explicite → destinataire → dossier → opérateur →
 * français.
 */

export type Locale = "fr" | "en";

export const LOCALES: readonly Locale[] = ["fr", "en"] as const;

/** Repli explicite : l'espace OHADA est francophone, un destinataire sans langue connue est francophone. */
export const DEFAULT_LOCALE: Locale = "fr";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** « en-GB », « FR_fr » → « en », « fr ». Toute autre valeur donne `undefined`. */
export function normalizeLocale(value: string | null | undefined): Locale | undefined {
  if (typeof value !== "string") return undefined;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : undefined;
}

export interface LocaleSources {
  /** Demande explicite (choix d'écran, paramètre d'API). */
  requested?: string | null | undefined;
  /** Langue du destinataire : tiers relancé, dirigeant notifié, personne invitée. */
  recipient?: string | null | undefined;
  /** Langue de tenue du dossier (`company`). */
  company?: string | null | undefined;
  /** Langue de l'opérateur (`app_user.locale`). */
  user?: string | null | undefined;
  fallback?: Locale | undefined;
}

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
