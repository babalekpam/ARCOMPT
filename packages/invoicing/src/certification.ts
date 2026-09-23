// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID, createHash } from "node:crypto";
import type { CountryPack } from "@arcompt/country-packs";
import type { Certification, SalesDocument } from "./types.js";

export interface CertificationResult {
  reference: string;
  qrCode: string;
  certifiedAt: string;
}

/**
 * Connecteur de facture électronique certifiée (FNE en Côte d'Ivoire, MECeF au
 * Bénin…). Le pack pays indique si la certification est obligatoire ; l'API
 * réelle de chaque plateforme est branchée derrière cette interface.
 */
export interface CertificationConnector {
  readonly name: string;
  /** false : aucun connecteur réel (NullConnector) — bloque l'émission si le pack l'exige. */
  readonly configured: boolean;
  certify(invoice: SalesDocument): Promise<CertificationResult>;
}

/** Aucun connecteur : les factures sont émises sans certification (pays où elle n'est pas exigée). */
export class NullConnector implements CertificationConnector {
  readonly name = "none";
  readonly configured = false;
  certify(): Promise<CertificationResult> {
    return Promise.reject(new Error("Aucun connecteur de certification configuré"));
  }
}

/** Simulateur FNE pour le développement et les tests : référence et QR déterministes. */
export class MockFneConnector implements CertificationConnector {
  readonly name = "fne-mock";
  readonly configured = true;
  readonly calls: string[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async certify(invoice: SalesDocument): Promise<CertificationResult> {
    this.calls.push(invoice.id);
    const reference = `FNE-${(invoice.number ?? randomUUID()).replace(/[^A-Z0-9]/gi, "")}-${createHash("sha256").update(invoice.id).digest("hex").slice(0, 8).toUpperCase()}`;
    const qrCode = Buffer.from(`${reference}|${invoice.totalGross.toString()}|${invoice.currency}|${invoice.issueDate}`).toString("base64");
    return { reference, qrCode, certifiedAt: this.now().toISOString() };
  }
}

/** La certification est-elle exigée par le pack à cette date ? */
export function certificationRequired(pack: CountryPack, date: string): boolean {
  const c = pack.certified_invoice;
  if (!c || !c.mandatory) return false;
  return c.since === undefined || date >= c.since;
}

export function toCertification(pack: CountryPack, r: CertificationResult): Certification {
  return { system: pack.certified_invoice?.system ?? "unknown", reference: r.reference, qrCode: r.qrCode, certifiedAt: r.certifiedAt };
}
