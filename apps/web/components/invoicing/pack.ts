/**
 * Contexte de facturation côté serveur : pack pays du dossier (taux de TVA) et
 * devise. Le pays vient du portail (`/portal/org/companies`) quand il existe,
 * sinon de DEFAULT_COUNTRY_PACK ; la devise du dossier, sinon celle du pack,
 * sinon la devise par défaut de la configuration.
 */
import { apiTry } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { config } from "@/lib/config";
import type { Company, CountryPack } from "@/lib/types";
import type { PackVatRate } from "./types";

export interface InvoicingContext {
  packCode: string;
  currency: string;
  rates: PackVatRate[];
  /** Système de facture certifiée exigé par le pack (FNE…), sinon null. */
  certifiedSystem: string | null;
}

export async function loadInvoicingContext(): Promise<InvoicingContext> {
  const auth = await getAuthContext();
  const companies = await apiTry<{ companies?: Company[] } | Company[]>("/portal/org/companies");
  const list = companies.ok ? (Array.isArray(companies.data) ? companies.data : (companies.data.companies ?? [])) : [];
  const company = list.find((c) => c.id === auth?.tenantId);
  const packCode = (company?.countryCode ?? process.env.DEFAULT_COUNTRY_PACK ?? "ci").toLowerCase();
  const pack = await apiTry<CountryPack & { certified_invoice?: { system?: string } }>(`/packs/${packCode}`);
  const rates: PackVatRate[] = pack.ok ? ((pack.data.vat?.rates ?? []) as PackVatRate[]) : [];
  const currency = company?.currency ?? (pack.ok ? pack.data.identity.currency : undefined) ?? config.defaultCurrency();
  return { packCode, currency, rates, certifiedSystem: pack.ok ? (pack.data.certified_invoice?.system ?? null) : null };
}
