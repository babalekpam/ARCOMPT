#!/usr/bin/env node
/**
 * Création (ou rotation) du rôle de connexion applicatif, depuis l'image.
 *
 * Le schéma définit `arcompt_app` : rôle de GROUPE, `NOLOGIN`, non propriétaire
 * des tables, soumis à la Row-Level Security. L'API ne doit jamais se connecter
 * avec le propriétaire du schéma — il contourne la RLS et peut désactiver les
 * triggers d'inaltérabilité. Il lui faut donc un rôle de connexion membre du
 * groupe, et un rôle de connexion suppose un mot de passe : impossible à
 * versionner dans une migration.
 *
 * Ce fichier ne contient AUCUNE logique propre : validation du nom et du mot de
 * passe, DDL sans concaténation, contrôle des droits obtenus, tout vit dans
 * `packages/db/src/provision.ts`. Le dépôt offre déjà une entrée en ligne de
 * commande pour ce module, `scripts/provision-app-role.mts` — mais elle suppose
 * un dépôt installé et `tsx`, dont l'image de production ne dispose pas
 * (c'est précisément le but). D'où ce point d'entrée, strictement équivalent,
 * utilisable par la tâche de migration du déploiement.
 *
 * À exécuter avec `DATABASE_URL` pointant sur le PROPRIÉTAIRE du schéma, une
 * fois par base — puis à chaque rotation du mot de passe.
 *
 * Variables lues :
 *   DATABASE_URL     connexion propriétaire (migrations)
 *   APP_DB_USER      nom du rôle de connexion (défaut : arcompt_app_login)
 *   APP_DB_PASSWORD  mot de passe, 16 caractères au minimum
 *
 * Le chemin de ce fichier est identique dans le dépôt et dans l'image, pour que
 * les imports relatifs soient vrais des deux côtés :
 *
 *   DATABASE_URL=… APP_DB_PASSWORD=… pnpm exec tsx infra/docker/ops/provision-role.mjs
 */
import console from "node:console";
import process from "node:process";
import { createDb } from "../../../packages/db/src/client.js";
import { DEFAULT_APP_LOGIN, describeViolation, provisionAppRole } from "../../../packages/db/src/provision.js";

const login = process.env.APP_DB_USER?.trim() || DEFAULT_APP_LOGIN;
const password = process.env.APP_DB_PASSWORD ?? "";

if (!password) {
  console.error("[provision] APP_DB_PASSWORD est absent — le rôle de connexion applicatif ne peut pas être créé.");
  process.exit(1);
}

const db = createDb({ max: 1 });
try {
  const result = await provisionAppRole(db, { login, password });
  console.log(`[provision] rôle ${result.login} ${result.created ? "créé" : "mis à jour"}, membre de ${result.memberOf}, base ${result.database}`);
  if (!result.privileges.ok) {
    console.error("[provision] le modèle de droits n'est pas respecté :");
    for (const v of result.privileges.violations) console.error(`  - ${describeViolation(v)}`);
    process.exit(1);
  }
  console.log(`[provision] modèle de droits vérifié (${result.privileges.observations.length} contrôles)`);
  await db.end();
} catch (error) {
  // Le message d'erreur du module ne contient jamais le mot de passe.
  console.error("[provision] échec :", error instanceof Error ? error.message : error);
  await db.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
