// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { ApiError, packRefusal } from "./api-shared";

describe("refus d'un pack non publié", () => {
  it("retient le pack et son statut du refus PACK_NOT_PUBLISHED", () => {
    const err = new ApiError(409, "PACK_NOT_PUBLISHED", "Déclaration de TVA : refusé. Pack ci@2025.1 au statut DRAFT (sans reviewed_by)…", {
      pack: "ci@2025.1",
      status: "DRAFT",
      artefact: "Déclaration de TVA 2025-01-01 → 2025-01-31",
    });
    expect(packRefusal(err)).toEqual({ pack: "ci@2025.1", status: "DRAFT" });
  });

  it("supporte un refus sans détails", () => {
    expect(packRefusal(new ApiError(409, "PACK_NOT_PUBLISHED", "refusé"))).toEqual({ pack: "—", status: "—" });
    expect(packRefusal(new ApiError(409, "PACK_NOT_PUBLISHED", "refusé", { pack: 42 }))).toEqual({ pack: "—", status: "—" });
  });

  it("laisse passer les autres erreurs", () => {
    expect(packRefusal(new ApiError(409, "INVALID_STATE", "déjà validée"))).toBeNull();
    expect(packRefusal(new Error("réseau"))).toBeNull();
    expect(packRefusal(null)).toBeNull();
  });
});
