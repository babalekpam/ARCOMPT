import { describe, expect, it } from "vitest";
import { draftPackParams, isPackPublished, packLabel, packRef, packRefFromSummary, packStatusTone } from "./helpers";
import type { CountryPack, PackSummary } from "@/lib/types";

const pack = (over: Partial<CountryPack> = {}): CountryPack => ({
  code: "ci",
  name: "Côte d'Ivoire",
  version: "2025.1",
  status: "DRAFT",
  identity: { currency: "XOF", languages: ["fr"], tax_ids: [], accounting_systems: ["NORMAL"] },
  ...over,
});

describe("statut du pack pays", () => {
  it("n'accorde l'autorité qu'à un pack publié ET revu", () => {
    expect(isPackPublished(packRef(pack({ status: "PUBLISHED", reviewed_by: "Cabinet X" })))).toBe(true);
    expect(isPackPublished(packRef(pack({ status: "PUBLISHED" })))).toBe(false);
    expect(isPackPublished(packRef(pack({ status: "PUBLISHED", reviewed_by: "   " })))).toBe(false);
    expect(isPackPublished(packRef(pack({ status: "REVIEWED", reviewed_by: "Cabinet X" })))).toBe(false);
    expect(isPackPublished(packRef(pack()))).toBe(false);
    expect(isPackPublished(null)).toBe(false);
  });

  it("nomme le pack comme l'interface l'affiche", () => {
    expect(packLabel(packRef(pack()))).toBe("CI 2025.1");
  });

  it("ne dit rien d'un pack qui fait autorité, ni d'un pack inconnu", () => {
    expect(draftPackParams(packRef(pack({ status: "PUBLISHED", reviewed_by: "Cabinet X" })))).toBeNull();
    expect(draftPackParams(null)).toBeNull();
    expect(draftPackParams(undefined)).toBeNull();
  });

  it("nomme le pack et son statut quand il est en cours de rédaction", () => {
    expect(draftPackParams(packRef(pack()))).toEqual({ pack: "CI 2025.1", status: "DRAFT" });
    expect(draftPackParams(packRef(pack({ status: "REVIEWED", reviewed_by: "Cabinet X" })))).toEqual({ pack: "CI 2025.1", status: "REVIEWED" });
  });

  it("garde les tons de badge de l'écran Paramètres", () => {
    expect(packStatusTone("PUBLISHED")).toBe("success");
    expect(packStatusTone("REVIEWED")).toBe("info");
    expect(packStatusTone("DRAFT")).toBe("warning");
  });

  it("lit aussi le résumé de la liste des packs", () => {
    const summary: PackSummary = { code: "sn", name: "Sénégal", version: "2025.1", status: "DRAFT", currency: "XOF" };
    expect(draftPackParams(packRefFromSummary(summary))).toEqual({ pack: "SN 2025.1", status: "DRAFT" });
    expect(isPackPublished(packRefFromSummary({ ...summary, status: "PUBLISHED" }))).toBe(true);
  });
});
