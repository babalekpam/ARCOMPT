/**
 * Contexte de facturation côté serveur : pack pays du dossier (taux de TVA) et
 * devise. Le pays vient du portail (`/portal/org/companies`) quand il existe,
 * sinon de DEFAULT_COUNTRY_PACK ; la devise du dossier, sinon celle du pack,
 * sinon la devise par défaut de la configuration.
 *
 * Les taux de TVA portés sur une facture viennent du pack, donc son statut
 * compte ici aussi. `packDraft` le dit quand il y a lieu ; c'est aux écrans de
 * facturation de rester discrets avec — une facture n'est pas une déclaration.
 */
import { config } from "@/lib/config";
import { loadCompanyPack } from "@/components/packs/context";
import type { PackVatRate } from "./types";

export interface InvoicingContext {
  packCode: string;
  currency: string;
  rates: PackVatRate[];
  /** Système de facture certifiée exigé par le pack (FNE…), sinon null. */
  certifiedSystem: string | null;
  /** Nom du pack quand il est en cours de rédaction : ses taux sont indicatifs. */
  packDraft: string | null;
}

export async function loadInvoicingContext(): Promise<InvoicingContext> {
  const { packCode, company, pack, draft } = await loadCompanyPack();
  const rates: PackVatRate[] = (pack?.vat?.rates ?? []) as PackVatRate[];
  const currency = company?.currency ?? pack?.identity.currency ?? config.defaultCurrency();
  return { packCode, currency, rates, certifiedSystem: pack?.certified_invoice?.system ?? null, packDraft: draft?.pack ?? null };
}
