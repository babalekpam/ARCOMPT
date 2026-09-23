// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Première appartenance OWNER réelle, sans écriture de démonstration.
 * Lecture seule par défaut. Voir docs/DEPLOYMENT-REPLIT.md § 10.
 */
import { createDb } from "../packages/db/src/client.js";
import { createFirstOwner, previewFirstOwner, validateFirstOwnerInput } from "./lib/bootstrap-owner.mjs";

function argument(name: string): string {
  const matches = process.argv.slice(2).flatMap((arg, index, args) =>
    arg === `--${name}` ? [args[index + 1] ?? ""] : arg.startsWith(`--${name}=`) ? [arg.slice(name.length + 3)] : [],
  );
  if (matches.length !== 1 || !matches[0] || matches[0]!.startsWith("--")) throw new Error(`Argument --${name} requis (une seule fois).`);
  return matches[0]!;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const input = validateFirstOwnerInput({
    email: argument("email"),
    name: argument("name"),
    organization: argument("org"),
    company: argument("company"),
    country: argument("country"),
    year: Number(argument("year")),
    kind: argument("kind") as "COMPANY" | "FIRM",
  });
  const db = createDb({ max: 4 });
  try {
    const preview = await previewFirstOwner(db, input);
    console.log(`Base : ${preview.database}`);
    console.log(`Organisation : ${input.organization} (${input.kind}) · dossier : ${input.company}`);
    console.log(`Titulaire : ${input.name} <${input.email}> · rôle OWNER`);
    console.log(`Pack : ${preview.packVersion} (${preview.packStatus}) · devise : ${preview.currency} · exercice : ${input.year}`);
    if (preview.packStatus !== "PUBLISHED") console.warn("Attention : ce pack pays n'est pas publié ; barèmes et déclarations ne sont pas officiels.");
    if (input.kind === "FIRM") console.warn("Un cabinet exige une authentification multifacteur chez le fournisseur OIDC.");
    if (preview.existing) {
      console.log(`Déjà présent : organisation ${preview.existing.organizationId}, dossier ${preview.existing.companyId}, utilisateur ${preview.existing.userId}. Aucun changement.`);
      return;
    }
    if (!apply) {
      console.log(`Aucun changement (aperçu). Pour créer, relancez avec --apply --confirm-db ${preview.database}.`);
      return;
    }
    const result = await createFirstOwner(db, input, argument("confirm-db"));
    console.log(`${result.created ? "Créé" : "Déjà présent (aucun changement)"} : organisation ${result.organizationId}, dossier ${result.companyId}, utilisateur ${result.userId}.`);
    if (result.created) console.log("Aucun tiers ni aucune écriture de démonstration ajouté.");
    console.log("Créez ensuite la même adresse vérifiée chez le fournisseur OIDC ; le premier jeton vérifié rattachera ce compte.");
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});