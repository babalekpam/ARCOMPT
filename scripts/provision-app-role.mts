// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Création du rôle de connexion applicatif, une fois par base.
 *
 *   DATABASE_URL=postgres://<compte_proprietaire>@… \
 *   APP_DB_PASSWORD='<mot de passe fort>' \
 *   pnpm exec tsx scripts/provision-app-role.ts
 *
 * DATABASE_URL doit pointer ici le compte qui applique les migrations
 * (propriétaire du schéma). Le script crée — ou remet en conformité — un rôle
 * de connexion membre de `arcompt_app`, puis vérifie que le modèle de droits
 * du schéma est bien celui obtenu. Relancé avec un autre mot de passe, il sert
 * de rotation.
 *
 * C'est ce rôle, et non le propriétaire, que doivent utiliser l'API et le
 * worker : `DATABASE_URL` de production est ensuite réécrit dessus.
 *
 * Options (variables d'environnement) :
 *   APP_DB_PASSWORD  (obligatoire) mot de passe du rôle de connexion
 *   APP_DB_USER      (facultatif)  nom du rôle, par défaut arcompt_app_login
 *   APP_DB_ROLE      (facultatif)  synonyme d'APP_DB_USER
 */
import { createDb } from "../packages/db/src/client.js";
import { DEFAULT_APP_LOGIN, ProvisionError, describeViolation, provisionAppRole } from "../packages/db/src/provision.js";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** URL à copier dans la configuration, mot de passe masqué. */
function maskedUrl(adminUrl: string, login: string): string {
  try {
    const url = new URL(adminUrl);
    url.username = login;
    url.password = "********";
    return url.toString();
  } catch {
    return `postgres://${login}:********@<hôte>:5432/<base>`;
  }
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) fail("DATABASE_URL manquant : il doit pointer le compte propriétaire du schéma (celui des migrations).");

const password = process.env.APP_DB_PASSWORD;
if (!password) fail("APP_DB_PASSWORD manquant : fournissez le mot de passe depuis le gestionnaire de secrets, jamais en dur.");

// `APP_DB_USER` est le nom utilisé par la tâche de migration de l'image
// (infra/docker/ops) ; `APP_DB_ROLE` reste accepté en synonyme.
const login = process.env.APP_DB_USER?.trim() || process.env.APP_DB_ROLE?.trim() || DEFAULT_APP_LOGIN;
const db = createDb({ url: adminUrl, max: 1 });

try {
  const result = await provisionAppRole(db, { login, password });
  console.log(`✓ rôle ${result.login} ${result.created ? "créé" : "déjà présent (mot de passe et attributs remis en place)"}`);
  console.log(`  membre de       : ${result.memberOf}`);
  console.log(`  base            : ${result.database}`);
  console.log(`  attributs       : superuser=${result.attributes.superuser} bypassrls=${result.attributes.bypassRls} createrole=${result.attributes.createRole} createdb=${result.attributes.createDb}`);
  console.log(`  droits vérifiés : ${result.privileges.observations.length} contrôles has_table_privilege`);

  if (!result.privileges.ok) {
    console.error("✗ modèle de droits non respecté :");
    for (const v of result.privileges.violations) console.error(`  - ${describeViolation(v)}`);
    console.error("  La base a divergé du schéma : appliquez les migrations (pnpm db:migrate) puis relancez.");
    process.exit(2);
  }

  console.log("");
  console.log("À faire ensuite : basculer DATABASE_URL de l'API et du worker sur ce rôle.");
  console.log(`  DATABASE_URL=${maskedUrl(adminUrl, login)}   (remplacez ******** par le mot de passe fourni)`);
  console.log("Le compte propriétaire ne sert plus qu'aux migrations.");
} catch (e) {
  if (e instanceof ProvisionError) fail(e.message);
  throw e;
} finally {
  await db.end();
}
