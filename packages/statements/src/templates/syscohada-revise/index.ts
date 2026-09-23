// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { TemplateSet } from "../../types.js";
import { BILAN_ACTIF, BILAN_PASSIF } from "./bilan.js";
import { COMPTE_RESULTAT } from "./compte-resultat.js";
import { NOTES } from "./notes.js";
import { TFT } from "./tft.js";

export const SYSCOHADA_REVISE_2017_1: TemplateSet = {
  id: "syscohada-revise",
  version: "2017.1",
  statements: [BILAN_ACTIF, BILAN_PASSIF, COMPTE_RESULTAT, TFT],
  notes: NOTES,
};

export const TEMPLATES: Record<string, TemplateSet> = {
  [SYSCOHADA_REVISE_2017_1.version]: SYSCOHADA_REVISE_2017_1,
};

export const DEFAULT_TEMPLATE_VERSION = SYSCOHADA_REVISE_2017_1.version;
