import type { Sql } from "postgres";
import { MoneyError } from "./money.js";
import type { Id } from "./types.js";

const ISO_4217 = /^[A-Z]{3}$/;

/** Normalise un code devise ISO 4217 (majuscules, trois lettres). */
export function normalizeCurrency(code: string): string {
  const c = code.trim().toUpperCase();
  if (!ISO_4217.test(c)) throw new MoneyError(`Code devise invalide : "${code}" (ISO 4217 attendu, trois lettres)`);
  return c;
}

/** Vrai si le code est un code ISO 4217 plausible, sans lever. */
export function isCurrencyCode(code: string): boolean {
  return ISO_4217.test(code.trim().toUpperCase());
}

/**
 * Devise de tenue de comptabilité d'un dossier. C'est la colonne `currency` de
 * `company` qui fait foi, pas un réglage de processus : un dossier camerounais
 * tient ses comptes en XAF même si l'API a démarré avec XOF par défaut.
 */
export interface CurrencyResolver {
  /** Devise du dossier, ou null si le dossier est inconnu. */
  currencyFor(tenantId: Id): Promise<string | null>;
  /** Oublie le dossier (changement de devise, tests). Sans argument : tout le cache. */
  forget?(tenantId?: Id): void;
}

export interface CompanyCurrencyResolverOptions {
  /** Durée de vie d'une entrée du cache. Par défaut 5 minutes. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Résolveur adossé à PostgreSQL, avec cache à durée de vie.
 *
 * Il doit être construit **une fois par processus** et partagé par toutes les
 * requêtes : la devise d'un dossier ne change pratiquement jamais, et la relire
 * à chaque requête coûterait un aller-retour SQL sur le chemin de toute
 * écriture. Le cache expire tout de même, pour qu'une correction de devise soit
 * prise en compte sans redémarrage.
 *
 * La lecture passe par le contexte tenant (RLS) : un dossier ne peut pas lire
 * la devise d'un autre.
 */
export function createCompanyCurrencyResolver(sql: Sql, opts: CompanyCurrencyResolverOptions = {}): CurrencyResolver {
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<Id, { value: string | null; expiresAt: number }>();
  const inflight = new Map<Id, Promise<string | null>>();

  const read = async (tenantId: Id): Promise<string | null> => {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return tx`SELECT currency FROM company WHERE id = ${tenantId}`;
    });
    const raw = (rows as unknown as Array<{ currency?: string }>)[0]?.currency;
    return raw ? normalizeCurrency(raw) : null;
  };

  return {
    async currencyFor(tenantId: Id): Promise<string | null> {
      const hit = cache.get(tenantId);
      if (hit && hit.expiresAt > now()) return hit.value;
      // Deux requêtes simultanées sur un dossier froid ne déclenchent qu'une lecture.
      const pending = inflight.get(tenantId);
      if (pending) return pending;
      const p = read(tenantId)
        .then((value) => {
          cache.set(tenantId, { value, expiresAt: now() + ttl });
          return value;
        })
        .finally(() => inflight.delete(tenantId));
      inflight.set(tenantId, p);
      return p;
    },
    forget(tenantId?: Id): void {
      if (tenantId === undefined) cache.clear();
      else cache.delete(tenantId);
    },
  };
}

/** Résolveur fixe : tests, calculs hors ligne, fixtures. */
export function staticCurrencyResolver(byTenant: Record<Id, string>): CurrencyResolver {
  return {
    async currencyFor(tenantId: Id) {
      const c = byTenant[tenantId];
      return c ? normalizeCurrency(c) : null;
    },
  };
}
