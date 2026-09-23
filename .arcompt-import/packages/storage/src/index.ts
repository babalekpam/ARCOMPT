// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { LocalStorage } from "./local.js";
import { R2Storage, r2OptionsFromEnv } from "./r2.js";
import { StorageError, type Storage } from "./storage.js";

export * from "./storage.js";
export * from "./local.js";
export * from "./r2.js";

/**
 * Garde-fou des replis simulés (voir apps/api/src/config.ts, même contrat).
 * En production, un repli ne peut être choisi silencieusement : soit la
 * dépendance réelle est configurée, soit l'opt-out `ALLOW_INSECURE_*=1` est
 * posé explicitement. Hors production, on avertit et on continue.
 */
export function guardSimulatedDependency(opts: {
  simulated: string;
  missing: string;
  optOut?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): void {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const raw = opts.optOut ? (env[opts.optOut] ?? "").trim().toLowerCase() : "";
  const allowed = raw === "1" || raw === "true" || raw === "yes";
  if (env.NODE_ENV === "production" && !allowed) {
    const escape = opts.optOut ? ` Posez ${opts.optOut}=1 pour l'accepter explicitement.` : "";
    throw new StorageError(
      "CONFIG",
      `Configuration de production invalide : ${opts.missing} — sans cela, ${opts.simulated} serait simulé, ce qui est interdit en production.${escape}`,
    );
  }
  warn(`[arcompt] SIMULATION : ${opts.simulated} (${opts.missing}). Jamais en production.`);
}

/**
 * R2 si les variables R2_* sont présentes, sinon stockage local dans
 * STORAGE_DIR (défaut ./.data/storage). Le repli local est refusé en
 * production (sauf ALLOW_INSECURE_STORAGE=1) : les pièces à conservation
 * décennale (AUDCIF) seraient écrites sur un disque de conteneur éphémère.
 */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
  const r2 = r2OptionsFromEnv(env);
  if (r2) return new R2Storage(r2);
  guardSimulatedDependency({
    env,
    simulated: "le stockage objet des pièces (écriture sur le disque éphémère du conteneur, perte à chaque redéploiement)",
    missing: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY et R2_BUCKET sont absents",
    optOut: "ALLOW_INSECURE_STORAGE",
  });
  return new LocalStorage(env.STORAGE_DIR);
}
