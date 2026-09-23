// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Pack pays du dossier courant, côté serveur.
 *
 * Le pays vient du portail (`/portal/org/companies`) quand il existe, sinon de
 * `DEFAULT_COUNTRY_PACK`. Un seul chargeur pour tous les écrans qui ont besoin
 * de savoir si le pack fait autorité : facturation, TVA, liasse.
 */
import { apiTry } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import type { Company, CountryPack } from "@/lib/types";
import { draftPackParams, packRef, type PackRef } from "./helpers";

/** Le pack tel que l'API le renvoie, avec les extensions qui n'ont pas de type partagé. */
export type PackPayload = CountryPack & { certified_invoice?: { system?: string } };

export interface CompanyPack {
  packCode: string;
  company: Company | undefined;
  /** Pack chargé, `null` si l'API est absente ou le pack introuvable. */
  pack: PackPayload | null;
  ref: PackRef | null;
  /** Nom et statut du pack quand il est en cours de rédaction ; `null` sinon. */
  draft: { pack: string; status: string } | null;
}

export async function loadCompanyPack(): Promise<CompanyPack> {
  const auth = await getAuthContext();
  const companies = await apiTry<{ companies?: Company[] } | Company[]>("/portal/org/companies");
  const list = companies.ok ? (Array.isArray(companies.data) ? companies.data : (companies.data.companies ?? [])) : [];
  const company = list.find((c) => c.id === auth?.tenantId);
  const packCode = (company?.countryCode ?? process.env.DEFAULT_COUNTRY_PACK ?? "ci").toLowerCase();
  const res = await apiTry<PackPayload>(`/packs/${packCode}`);
  const pack = res.ok ? res.data : null;
  const ref = pack ? packRef(pack) : null;
  return { packCode, company, pack, ref, draft: draftPackParams(ref) };
}
