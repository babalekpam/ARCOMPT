import type { Sql } from "postgres";
import { normalizeCurrency } from "./currency.js";
import { invertRate, parseRate } from "./money.js";
import type { Id } from "./types.js";

/**
 * Convention unique dans tout le produit :
 *
 *     montant en `from` × rate = montant en `to`
 *
 * Le taux porté par une ligne d'écriture va donc toujours de la devise de la
 * ligne vers la devise du dossier. Le même sens est stocké en base
 * (`exchange_rate.from_currency` → `to_currency`) et vérifié par le trigger
 * `journal_line_currency_guard`.
 */
export interface ExchangeRateQuote {
  from: string;
  to: string;
  /** Taux à 10 décimales, en chaîne : jamais un flottant. */
  rate: string;
  /** 'FIXED', 'BCEAO', 'BEAC', 'CENTRAL_BANK', 'MANUAL', 'IMPORT', 'API'. */
  source: string;
  /** Provenance lisible : bulletin, URL, fichier importé. */
  sourceRef: string | null;
  /** Date d'effet du taux retenu. */
  validFrom: string;
  /** Vrai si le taux a été obtenu en inversant la paire opposée (précision réduite). */
  inverted: boolean;
}

export interface RateProvider {
  /** Taux applicable à `date` pour convertir `from` vers `to`, ou null. */
  getRate(tenantId: Id, from: string, to: string, date: string): Promise<ExchangeRateQuote | null>;
}

/**
 * Parités fixes de la zone franc, dupliquées ici pour le mode hors ligne et
 * les tests. La source de vérité reste la table `exchange_rate`, alimentée par
 * la migration 0012 ; ces valeurs doivent lui rester identiques.
 */
export const FIXED_PARITIES: ReadonlyArray<{ from: string; to: string; rate: string; ref: string }> = [
  { from: "EUR", to: "XOF", rate: "655.9570000000", ref: "Parité fixe UEMOA — 1 EUR = 655,957 XOF" },
  { from: "XOF", to: "EUR", rate: "0.0015244902", ref: "Parité fixe UEMOA — inverse de 655,957" },
  { from: "EUR", to: "XAF", rate: "655.9570000000", ref: "Parité fixe CEMAC — 1 EUR = 655,957 XAF" },
  { from: "XAF", to: "EUR", rate: "0.0015244902", ref: "Parité fixe CEMAC — inverse de 655,957" },
  { from: "EUR", to: "KMF", rate: "491.9677500000", ref: "Parité fixe comorienne — 1 EUR = 491,96775 KMF" },
  { from: "KMF", to: "EUR", rate: "0.0020326536", ref: "Parité fixe comorienne — inverse de 491,96775" },
  { from: "XOF", to: "XAF", rate: "1.0000000000", ref: "Même parité à l'euro que le XAF" },
  { from: "XAF", to: "XOF", rate: "1.0000000000", ref: "Même parité à l'euro que le XOF" },
];

const FIXED_FROM = "1999-01-01";

export interface StaticRate {
  from: string;
  to: string;
  rate: string;
  /** Date d'effet ; le taux vaut jusqu'à ce qu'un plus récent le remplace. */
  validFrom?: string;
  source?: string;
  sourceRef?: string;
}

/**
 * Fournisseur en mémoire : tests, simulation, saisie hors ligne. Contient les
 * parités fixes de la zone franc par défaut, pour qu'une facture en euros d'un
 * dossier XOF se convertisse sans que personne ne saisisse rien.
 */
export class StaticRateProvider implements RateProvider {
  private readonly rates: StaticRate[];

  constructor(rates: StaticRate[] = [], opts: { withFixedParities?: boolean } = {}) {
    const fixed = opts.withFixedParities === false ? [] : FIXED_PARITIES.map((p) => ({ ...p, validFrom: FIXED_FROM, source: "FIXED", sourceRef: p.ref }));
    this.rates = [...fixed, ...rates.map((r) => ({ ...r, from: normalizeCurrency(r.from), to: normalizeCurrency(r.to) }))];
  }

  add(rate: StaticRate): void {
    this.rates.push({ ...rate, from: normalizeCurrency(rate.from), to: normalizeCurrency(rate.to) });
  }

  async getRate(_tenantId: Id, from: string, to: string, date: string): Promise<ExchangeRateQuote | null> {
    const f = normalizeCurrency(from);
    const t = normalizeCurrency(to);
    if (f === t) return identity(f, date);
    const direct = pick(this.rates, f, t, date);
    if (direct) return quote(direct, false);
    const reverse = pick(this.rates, t, f, date);
    return reverse ? quote({ ...reverse, from: f, to: t, rate: invertRate(reverse.rate) }, true) : null;
  }
}

function pick(rates: StaticRate[], from: string, to: string, date: string): StaticRate | null {
  let best: StaticRate | null = null;
  for (const r of rates) {
    if (r.from !== from || r.to !== to) continue;
    const vf = r.validFrom ?? FIXED_FROM;
    if (vf > date) continue;
    if (!best || vf >= (best.validFrom ?? FIXED_FROM)) best = r;
  }
  return best;
}

function quote(r: StaticRate, inverted: boolean): ExchangeRateQuote {
  return {
    from: r.from,
    to: r.to,
    rate: r.rate,
    source: r.source ?? "MANUAL",
    sourceRef: r.sourceRef ?? null,
    validFrom: r.validFrom ?? FIXED_FROM,
    inverted,
  };
}

function identity(currency: string, date: string): ExchangeRateQuote {
  return { from: currency, to: currency, rate: "1.0000000000", source: "FIXED", sourceRef: "Devise du dossier", validFrom: date, inverted: false };
}

/**
 * Fournisseur adossé à la table `exchange_rate`.
 *
 * Priorité de sélection : la date d'effet la plus récente qui couvre la date
 * demandée, puis le taux du dossier avant la parité fixe du système — un
 * dossier peut donc déroger, mais personne n'a à ressaisir une parité fixe.
 * Si seul le sens opposé existe, le taux est inversé et signalé comme tel.
 */
export class PostgresRateProvider implements RateProvider {
  constructor(
    private readonly sql: Sql,
    private readonly ctx: { userId?: Id; organizationId?: Id } = {},
  ) {}

  async getRate(tenantId: Id, from: string, to: string, date: string): Promise<ExchangeRateQuote | null> {
    const f = normalizeCurrency(from);
    const t = normalizeCurrency(to);
    if (f === t) return identity(f, date);
    const rows = await this.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`select set_config('app.organization_id', ${this.ctx.organizationId ?? ""}, true)`;
      await tx`select set_config('app.user_id', ${this.ctx.userId ?? ""}, true)`;
      return tx`
        SELECT from_currency, to_currency, rate::text AS rate, source, source_ref, valid_from::text AS valid_from,
               (tenant_id IS NOT NULL) AS own
          FROM exchange_rate
         WHERE ((from_currency = ${f} AND to_currency = ${t}) OR (from_currency = ${t} AND to_currency = ${f}))
           AND valid_from <= ${date}::date
           AND (valid_until IS NULL OR valid_until >= ${date}::date)
         ORDER BY (from_currency = ${f}) DESC, valid_from DESC, own DESC
         LIMIT 1`;
    });
    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) return null;
    const inverted = (r.from_currency as string) !== f;
    return {
      from: f,
      to: t,
      rate: inverted ? invertRate(r.rate as string) : (r.rate as string),
      source: r.source as string,
      sourceRef: (r.source_ref as string | null) ?? null,
      validFrom: r.valid_from as string,
      inverted,
    };
  }
}

/** Vrai si le taux est utilisable pour une conversion (fini et strictement positif). */
export function isUsableRate(rate: string | number | null | undefined): boolean {
  if (rate === null || rate === undefined || rate === "") return false;
  try {
    return parseRate(rate) > 0n;
  } catch {
    return false;
  }
}
