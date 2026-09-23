import { describe, expect, it } from "vitest";
import { loadPack } from "./loader.js";
import {
  assertPackPublished,
  draftPackNotice,
  DRAFT_PACK_FILINGS_OPT_OUT,
  isPackPublished,
  NON_OFFICIAL_MARK,
  packReference,
  PackNotPublishedError,
} from "./official.js";
import type { CountryPack } from "./schema.js";

const draft = loadPack("ci");
const published: CountryPack = { ...draft, status: "PUBLISHED", reviewed_by: "Cabinet X, expert-comptable inscrit à l'ordre (CI)" };
const reviewed: CountryPack = { ...draft, status: "REVIEWED", reviewed_by: "Cabinet X" };
const publishedWithoutReviewer: CountryPack = { ...draft, status: "PUBLISHED" };

describe("garde des documents légaux", () => {
  it("les packs livrés sont tous en DRAFT : aucun ne fait autorité", () => {
    expect(draft.status).toBe("DRAFT");
    expect(isPackPublished(draft)).toBe(false);
    expect(isPackPublished(reviewed)).toBe(false);
    // Publié mais sans reviewed_by : le chargeur le refuse déjà, la garde aussi.
    expect(isPackPublished(publishedWithoutReviewer)).toBe(false);
    expect(isPackPublished(published)).toBe(true);
  });

  it("refuse un document légal et dit le pack, son statut et ce qu'il reste à faire", () => {
    let thrown: PackNotPublishedError | null = null;
    try {
      assertPackPublished(draft, { artefact: "Liasse fiscale (DSF) 2025", env: {} });
    } catch (e) {
      thrown = e as PackNotPublishedError;
    }
    expect(thrown).toBeInstanceOf(PackNotPublishedError);
    expect(thrown!.code).toBe("PACK_NOT_PUBLISHED");
    expect(thrown!.pack).toMatchObject({ code: "ci", status: "DRAFT", reviewedBy: null });
    // Le message nomme le document, le pack, son statut, le remède et l'échappement.
    expect(thrown!.message).toContain("Liasse fiscale (DSF) 2025");
    expect(thrown!.message).toContain(packReference(draft));
    expect(thrown!.message).toContain("DRAFT");
    expect(thrown!.message).toContain("reviewed_by");
    expect(thrown!.message).toContain("PUBLISHED");
    expect(thrown!.message).toContain(DRAFT_PACK_FILINGS_OPT_OUT);
  });

  it("un pack publié et revu produit un document officiel, sans mention", () => {
    const use = assertPackPublished(published, { artefact: "Déclaration de TVA", env: {} });
    expect(use).toMatchObject({ official: true, notice: null, packStatus: "PUBLISHED", packReference: "ci@2025.1" });
    expect(draftPackNotice(published)).toBeNull();
  });

  it("l'échappement est fermé par défaut et ne s'ouvre que sur une valeur explicite", () => {
    for (const value of [undefined, "", "0", "false", "no", "oui"]) {
      expect(() => assertPackPublished(draft, { artefact: "Dépôt", env: { [DRAFT_PACK_FILINGS_OPT_OUT]: value } })).toThrow(PackNotPublishedError);
    }
    for (const value of ["1", "true", "YES"]) {
      expect(assertPackPublished(draft, { artefact: "Dépôt", env: { [DRAFT_PACK_FILINGS_OPT_OUT]: value }, warn: () => {} }).official).toBe(false);
    }
  });

  it("sous l'échappement, le document est produit mais marqué non officiel et l'exploitant est averti", () => {
    const warnings: string[] = [];
    const use = assertPackPublished(draft, {
      artefact: "Déclarations sociales et fiscales de paie 2025-03",
      env: { [DRAFT_PACK_FILINGS_OPT_OUT]: "1" },
      warn: (m) => warnings.push(m),
    });
    expect(use.official).toBe(false);
    expect(use.notice).toContain(NON_OFFICIAL_MARK);
    expect(use.notice).toContain("ci@2025.1");
    expect(use.notice).toContain("DRAFT");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(NON_OFFICIAL_MARK);
    expect(warnings[0]).toContain(DRAFT_PACK_FILINGS_OPT_OUT);
  });

  it("la mention d'écran dit le statut sans rien refuser", () => {
    const notice = draftPackNotice(draft);
    expect(notice).toContain("ci@2025.1");
    expect(notice).toContain("DRAFT");
    expect(notice).toContain("indicatifs");
  });
});
