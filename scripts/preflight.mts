// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Contrôle avant mise en ligne : la plateforme ENTIÈRE, en une commande.
 *
 *   pnpm preflight                              # tout ce qui se vérifie sans réseau sortant
 *   pnpm preflight --mail                       # ajoute la connexion SMTP réelle
 *   pnpm preflight --url https://arcompt.com    # ajoute le déploiement déjà en ligne
 *
 * Pourquoi ce script existe. Le dépôt sait déjà refuser de démarrer sur un
 * simulateur (apps/api/src/config.ts) et sait déjà vérifier le modèle de droits
 * SQL (scripts/provision-app-role.mts). Mais ces refus arrivent chacun à leur
 * moment, sur des machines différentes, et une mise en ligne se perd exactement
 * là : une variable manquante découverte au troisième redéploiement, une RLS
 * désactivée découverte par un client qui voit le dossier d'un autre. Ici, tout
 * est éprouvé D'UN COUP, AVANT de publier, et le rapport dit pour chaque point
 * ce qui est prouvé, ce qui est seulement probable, et ce qui n'est pas
 * vérifiable d'ici.
 *
 * Ce que le rapport distingue, et pourquoi la distinction compte :
 *   ✗ BLOQUANT  — publier ainsi donne une plateforme cassée ou dangereuse.
 *   ⚠ DÉGRADÉ   — la plateforme démarre, une fonction est coupée ou simulée.
 *                 C'est acceptable POUR UN ESSAI, jamais pour une comptabilité
 *                 réelle, et la ligne dit ce qui sera perdu.
 *   ✓ PROUVÉ    — vérifié à l'instant, pas supposé.
 *   · NON VÉRIFIÉ — le contrôle demande quelque chose que ce script n'a pas
 *                 (un jeton réel, le compte propriétaire du schéma). La ligne
 *                 dit comment l'obtenir plutôt que de faire semblant.
 *
 * Le code de sortie vaut 1 s'il reste un point BLOQUANT : il est prévu pour
 * être la dernière commande d'un script de publication.
 *
 * L'environnement est lu comme s'il était en PRODUCTION (NODE_ENV=production
 * est forcé pour la lecture, jamais écrit) : contrôler autre chose que ce qui
 * sera servi ne contrôlerait rien.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../apps/api/src/config.js";
import { MailError, SmtpMailer, smtpOptionsFromEnv } from "../packages/mailer/src/index.js";
import { createDb } from "../packages/db/src/client.js";
import { APP_GROUP_ROLE, describeViolation, verifyAppPrivileges } from "../packages/db/src/provision.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Level = "ok" | "warn" | "fail" | "skip";

interface Check {
  stage: string;
  name: string;
  level: Level;
  detail: string;
  /** Le geste exact qui lève le point. Obligatoire dès que le niveau n'est pas « ok ». */
  fix?: string;
}

const checks: Check[] = [];
let stage = "";

function open(name: string): void {
  stage = name;
}
function ok(name: string, detail: string): void {
  checks.push({ stage, name, level: "ok", detail });
}
function warn(name: string, detail: string, fix: string): void {
  checks.push({ stage, name, level: "warn", detail, fix });
}
function fail(name: string, detail: string, fix: string): void {
  checks.push({ stage, name, level: "fail", detail, fix });
}
function skip(name: string, detail: string, fix: string): void {
  checks.push({ stage, name, level: "skip", detail, fix });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const liveUrl = arg("url");
const checkMail = flag("mail");

/** L'environnement tel que la production le lira. On ne l'écrit pas : on le lit. */
const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };

// ---------------------------------------------------------------------------
// 1. Exécution — ce que la machine doit fournir
// ---------------------------------------------------------------------------
open("Exécution");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) {
  ok("Node", `version ${process.versions.node} (le dépôt exige ≥ 20)`);
} else {
  fail("Node", `version ${process.versions.node}, en deçà des 20 exigés (package.json → engines)`, "Installez Node 20 ou 22. Sur Replit : modules = [\"nodejs-20\", …] dans .replit.");
}

/** Chromium sert au rendu des PDF (packages/render/src/pdf.ts) : sans lui, aucun état financier, aucune facture, aucun bulletin de paie ne se télécharge. */
function findChromium(): string | null {
  const declared = env.CHROMIUM_PATH?.trim();
  if (declared) return existsSync(declared) ? declared : null;
  const names = ["chromium", "chromium-browser", "google-chrome", "chrome"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const chromium = findChromium();
if (chromium) {
  ok("Chromium", `trouvé : ${chromium}`);
} else if (env.CHROMIUM_PATH?.trim()) {
  fail("Chromium", `CHROMIUM_PATH pointe « ${env.CHROMIUM_PATH} », qui n'existe pas`, "Corrigez CHROMIUM_PATH, ou retirez-le pour laisser la recherche dans PATH.");
} else {
  fail(
    "Chromium",
    "introuvable : tout téléchargement de PDF échouera — états financiers, factures, bulletins de paie, liasse DSF",
    "Docker : déjà dans l'image api. Replit : packages = [\"chromium\", …] dans .replit, puis CHROMIUM_PATH=$(command -v chromium).",
  );
}

// ---------------------------------------------------------------------------
// 2. Configuration — ce que l'API exige pour démarrer
// ---------------------------------------------------------------------------
open("Configuration");

const degradedLines: string[] = [];
let cfg: ReturnType<typeof loadConfig> | null = null;
try {
  cfg = loadConfig(env, { warn: (m) => degradedLines.push(m) });
  ok("Démarrage de l'API", "aucun problème bloquant : loadConfig() accepterait cet environnement en production");
} catch (e) {
  if (e instanceof ConfigError) {
    for (const problem of e.problems) {
      fail("Démarrage de l'API", problem, "Renseignez la variable réelle, ou posez l'opt-out ALLOW_INSECURE_* correspondant en sachant ce qu'il coûte (.env.example).");
    }
  } else {
    fail("Démarrage de l'API", `lecture impossible : ${e instanceof Error ? e.message : String(e)}`, "Corrigez l'environnement avant d'aller plus loin : rien d'autre ne peut être conclu tant que la configuration ne se lit pas.");
  }
}

for (const line of degradedLines) {
  warn("Fonction dégradée", line.replace(/\s+/g, " ").trim(), "Renseignez le service réel pour la rétablir. Acceptable pour un essai, pas pour une comptabilité réelle.");
}

if (cfg) {
  const simulated: Array<[string, boolean, string]> = [
    ["Extraction IA des pièces", cfg.ai.simulated, "Sans ANTHROPIC_API_KEY, fournisseur et montants sont INVENTÉS et entrent dans la file de validation."],
    ["Stockage des pièces", cfg.storage.driver !== "r2", "Sur disque local : éphémère sur Replit comme dans un conteneur, incompatible avec la conservation décennale AUDCIF."],
    ["Antivirus", cfg.antivirus.driver !== "clamav", "Tout fichier téléversé est accepté sans analyse."],
    ["Canal WhatsApp", cfg.whatsapp.simulated, "Les messages sortants sont avalés : le client ne reçoit rien."],
  ];
  for (const [name, isSimulated, consequence] of simulated) {
    if (isSimulated) warn(name, `simulé ou neutre. ${consequence}`, "Renseignez le service réel ; l'opt-out ALLOW_INSECURE_* ne fait que rendre la décision explicite.");
    else ok(name, "service réel configuré");
  }
  if (!cfg.payments.enabled) ok("Encaissement mobile money", "désactivé proprement (PAYMENT_PROVIDER vide) — fonction coupée, jamais simulée");
  else if (cfg.payments.simulated) fail("Encaissement mobile money", "un opérateur SIMULÉ est configuré : il annoncerait des règlements qui n'ont pas eu lieu", "Videz PAYMENT_PROVIDER : une fonction coupée vaut mieux qu'un encaissement inventé.");
  else ok("Encaissement mobile money", `opérateur ${cfg.payments.provider}`);
  if (cfg.certification.simulated) fail("Facture certifiée (FNE/MECeF)", "connecteur simulé : une référence fiscale inventée s'imprimerait sur les factures de vos clients", "Videz CERTIFICATION_CONNECTOR.");
  else ok("Facture certifiée (FNE/MECeF)", cfg.certification.connector === "" ? "désactivée proprement" : `connecteur ${cfg.certification.connector}`);
  if (cfg.insecure.draftPackFilings) {
    warn("Pack pays non publié", "les déclarations et la liasse peuvent être produites depuis un pack non PUBLISHED ; chaque document part marqué « DOCUMENT NON OFFICIEL »", "Prévu pour la pré-production. À retirer dès que le pack du pays est publié.");
  }
}

// ---------------------------------------------------------------------------
// 3. Messagerie — sans elle, aucune invitation n'arrive
// ---------------------------------------------------------------------------
open("Messagerie");

let smtp: ReturnType<typeof smtpOptionsFromEnv> = null;
try {
  smtp = smtpOptionsFromEnv(env);
} catch (e) {
  fail("Configuration SMTP", e instanceof MailError ? e.message : String(e), "Complétez le bloc SMTP_* de .env.example : une configuration à moitié posée n'est pas un repli.");
}

if (smtp) {
  ok("Configuration SMTP", `${smtp.host}:${smtp.port} (${smtp.secure ? "TLS dès la connexion" : "STARTTLS"}), expéditeur ${smtp.fromAddress}`);
  if (smtp.user && smtp.user.toLowerCase() !== smtp.fromAddress.toLowerCase()) {
    warn("Expéditeur", `SMTP_USER (${smtp.user}) diffère de MAIL_FROM_ADDRESS (${smtp.fromAddress})`, "Zoho, entre autres, refuse alors l'envoi APRÈS avoir accepté l'authentification. Alignez les deux.");
  }
  if (!smtp.user || !smtp.password) {
    warn("Authentification SMTP", "ni compte ni mot de passe : l'envoi suppose une authentification par adresse IP", "Renseignez SMTP_USER et SMTP_PASSWORD (mot de passe d'application si la double authentification est active).");
  }
  if (checkMail) {
    try {
      await new SmtpMailer(smtp).verify();
      ok("Connexion SMTP", "le serveur répond et accepte les identifiants");
    } catch (e) {
      fail(
        "Connexion SMTP",
        e instanceof Error ? e.message : String(e),
        "Domaine propre chez Zoho : smtppro.zoho.com, jamais smtp.zoho.com. Suffixe selon le centre de données (.com/.eu/.in/.com.au). Double authentification : mot de passe d'application.",
      );
    }
  } else {
    skip("Connexion SMTP", "non éprouvée : une configuration lisible ne prouve pas qu'un serveur réponde", "pnpm preflight --mail, puis pnpm mail:check --to vous@exemple.com pour une remise réelle.");
  }
  skip("SPF, DKIM, DMARC", "ne se lisent que chez le destinataire, pas d'ici", "Envoyez-vous un message (pnpm mail:check --to …), ouvrez l'en-tête complet et exigez spf=pass ET dkim=pass. Enregistrements : docs/OPERATIONS.md.");
} else {
  const allowed = String(env.ALLOW_INSECURE_MAIL ?? "").trim().toLowerCase();
  const optedOut = allowed === "1" || allowed === "true" || allowed === "yes";
  const detail = "aucun serveur d'envoi : invitations au portail, demandes de pièces, notifications d'accès administrateur et relances de règlement ne quitteraient pas le serveur";
  if (optedOut) warn("Configuration SMTP", `${detail} (ALLOW_INSECURE_MAIL posé : décision assumée)`, "Un expert-comptable invité ne recevra jamais son code à usage unique. À lever avant toute utilisation réelle.");
  else fail("Configuration SMTP", detail, "Renseignez SMTP_HOST et MAIL_FROM_ADDRESS (bloc Zoho prêt dans .env.example).");
}

// ---------------------------------------------------------------------------
// 4. Identité — le fournisseur OIDC
// ---------------------------------------------------------------------------
open("Identité");

const authMode = (env.AUTH_MODE ?? "").trim();
if (authMode !== "oidc") {
  fail("Mode d'authentification", `AUTH_MODE=« ${authMode || "(vide)"} » : le mode dev accepte l'en-tête X-Tenant-Id SANS jeton — n'importe qui entre dans n'importe quel dossier`, "AUTH_MODE=oidc, avec KEYCLOAK_ISSUER et KEYCLOAK_CLIENT_ID renseignés.");
}

const issuer = env.KEYCLOAK_ISSUER?.trim();
const audience = env.KEYCLOAK_CLIENT_ID?.trim();
const webClient = env.KEYCLOAK_WEB_CLIENT_ID?.trim();

if (!issuer) {
  fail("Émetteur", "KEYCLOAK_ISSUER absent", "L'URL du realm, par exemple https://auth.arcompt.com/realms/arcompt.");
} else {
  const discovery = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  try {
    const res = await fetch(discovery, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      fail("Découverte OIDC", `${discovery} répond ${res.status}`, "L'API rend 503 « Fournisseur d'identité inexploitable » tant que ce document n'est pas servi. Vérifiez l'URL du realm et que le fournisseur est joignable depuis le serveur.");
    } else {
      const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
      if (doc.issuer && doc.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
        fail("Découverte OIDC", `le document annonce l'émetteur « ${doc.issuer} », KEYCLOAK_ISSUER dit « ${issuer} »`, "Les deux doivent coïncider au caractère près : la validation du jeton compare cette chaîne. Cas fréquent : http:// posé là où le fournisseur se sert en https://.");
      } else if (!doc.jwks_uri) {
        fail("Découverte OIDC", "aucun jwks_uri : les signatures de jeton ne pourraient pas être vérifiées", "Fournisseur mal configuré ou document incomplet.");
      } else {
        const jwks = await fetch(doc.jwks_uri, { signal: AbortSignal.timeout(10_000) });
        if (jwks.ok) ok("Découverte OIDC", `${discovery} et les clés publiques répondent`);
        else fail("Clés publiques", `${doc.jwks_uri} répond ${jwks.status}`, "Sans les clés, tout jeton est rejeté : 401 partout après une connexion pourtant réussie.");
      }
    }
  } catch (e) {
    fail("Découverte OIDC", `${discovery} injoignable : ${e instanceof Error ? e.message : String(e)}`, "Le fournisseur doit être joignable DEPUIS LE SERVEUR, pas seulement depuis votre navigateur.");
  }
}

if (!audience) {
  fail("Audience de l'API", "KEYCLOAK_CLIENT_ID absent côté API", "C'est l'audience exigée dans le jeton (client bearer-only), pas le client de connexion.");
} else if (webClient && webClient === audience) {
  fail("Audience de l'API", `l'API et le web utilisent le même identifiant de client (« ${audience} »)`, "Deux clients distincts sont exigés : le web se connecte (code flow), l'API n'accepte que les jetons dont l'audience est le client bearer-only.");
} else {
  ok("Audience de l'API", `audience exigée : ${audience}${webClient ? `, client de connexion : ${webClient}` : ""}`);
}

skip(
  "Correspondant d'audience (audience mapper)",
  "invérifiable sans un vrai jeton : c'est l'étape qu'on oublie, et elle donne des 401 partout alors que la connexion réussit",
  "Dans le fournisseur, sur le client WEB, ajoutez un mapper d'audience qui pose " + (audience ?? "l'audience de l'API") + " dans le claim aud. Preuve : connectez-vous et ouvrez un écran de données.",
);

// ---------------------------------------------------------------------------
// 5. Base de données — isolation, droits, migrations
// ---------------------------------------------------------------------------
open("Base de données");

const dbUrl = env.DATABASE_URL?.trim();
if (!dbUrl) {
  fail("Connexion", "DATABASE_URL absent", "Le compte de l'APPLICATION (membre de arcompt_app), jamais le propriétaire du schéma : scripts/provision-app-role.mts.");
} else {
  const db = createDb({ url: dbUrl, max: 1 });
  try {
    const [srv] = await db`SELECT version() AS v, current_user AS who, current_database() AS db`;
    ok("Connexion", `${String(srv!.who)}@${String(srv!.db)} — ${String(srv!.v).split(",")[0]}`);

    // --- Le compte utilisé ne doit rien pouvoir contourner ------------------
    const [role] = await db`
      SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
        FROM pg_roles WHERE rolname = current_user`;
    const dangerous: string[] = [];
    if (role?.rolsuper) dangerous.push("superuser");
    if (role?.rolbypassrls) dangerous.push("bypassrls");
    if (role?.rolcreaterole) dangerous.push("createrole");
    if (role?.rolcreatedb) dangerous.push("createdb");
    if (dangerous.length === 0) {
      ok("Compte applicatif", "ni superuser ni bypassrls : la RLS s'applique vraiment à ce compte");
    } else if (dangerous.includes("superuser") || dangerous.includes("bypassrls")) {
      fail(
        "Compte applicatif",
        `le compte porte ${dangerous.join(", ")} : la Row-Level Security NE S'APPLIQUE PAS. Un dossier verrait les écritures d'un autre`,
        "Créez le rôle restreint puis basculez DATABASE_URL dessus : APP_DB_PASSWORD=… pnpm exec tsx scripts/provision-app-role.mts",
      );
    } else {
      warn("Compte applicatif", `le compte porte ${dangerous.join(", ")} : plus de pouvoir que nécessaire`, "Retirez ces attributs, ou utilisez le rôle produit par scripts/provision-app-role.mts.");
    }

    // --- L'isolation multi-dossiers, table par table ------------------------
    // Le contrôle le plus important du script : une table qui porte tenant_id
    // sans RLS FORCÉE est une fuite entre clients, et elle ne se voit pas.
    const rls = await db`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id')
       ORDER BY c.relname`;
    if (rls.length === 0) {
      fail("Isolation par dossier", "aucune table portant tenant_id : le schéma n'est pas celui d'ARCOMPT, ou les migrations n'ont jamais été jouées", "pnpm db:migrate avec DATABASE_URL pointant le compte PROPRIÉTAIRE du schéma.");
    } else {
      const leaky = rls.filter((r) => !r.enabled || !r.forced).map((r) => String(r.table));
      if (leaky.length === 0) {
        ok("Isolation par dossier", `RLS activée ET forcée sur les ${rls.length} tables portant tenant_id`);
      } else {
        fail(
          "Isolation par dossier",
          `${leaky.length} table(s) sans RLS forcée : ${leaky.join(", ")} — un dossier peut lire les données d'un autre`,
          "Rejouez les migrations sur une base propre. Une RLS désactivée à la main ne se rattrape pas en production : les données ont déjà pu fuir.",
        );
      }
    }

    // --- Le modèle de droits, celui que provision-app-role.mts installe -----
    try {
      const verification = await verifyAppPrivileges(db, APP_GROUP_ROLE);
      if (verification.ok) ok("Droits SQL", `les ${verification.observations.length} contrôles du modèle de droits passent`);
      else {
        for (const v of verification.violations) {
          fail("Droits SQL", describeViolation(v), "APP_DB_PASSWORD=… pnpm exec tsx scripts/provision-app-role.mts, avec DATABASE_URL sur le compte propriétaire.");
        }
      }
    } catch (e) {
      fail("Droits SQL", `modèle de droits non vérifiable : ${e instanceof Error ? e.message : String(e)}`, `Le rôle de groupe ${APP_GROUP_ROLE} doit exister et le compte courant en être membre.`);
    }

    // --- Les migrations ----------------------------------------------------
    const files = readdirSync(path.join(ROOT, "packages/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    try {
      const applied = new Set((await db`SELECT name FROM schema_migration`).map((r) => String(r.name)));
      const missing = files.filter((f) => !applied.has(f));
      if (missing.length === 0) ok("Migrations", `les ${files.length} migrations du dépôt sont appliquées`);
      else fail("Migrations", `${missing.length} migration(s) non appliquée(s) : ${missing.join(", ")}`, "pnpm db:migrate, avec DATABASE_URL pointant le compte PROPRIÉTAIRE du schéma — jamais le compte applicatif.");
    } catch {
      // Attendu, et c'est une bonne nouvelle : le compte applicatif n'a pas le
      // droit de lire l'historique des migrations (EXPECTED_APP_PRIVILEGES).
      skip(
        "Migrations",
        "historique illisible depuis ce compte — ce qui est le comportement voulu du rôle restreint",
        `Depuis le compte propriétaire : DATABASE_URL=… pnpm exec tsx scripts/preflight.mts. Le dépôt compte ${files.length} migrations, la dernière étant ${files.at(-1)}.`,
      );
    }
  } catch (e) {
    fail("Connexion", `PostgreSQL injoignable : ${e instanceof Error ? e.message : String(e)}`, "Vérifiez l'hôte, le port, le mot de passe, et que la base accepte les connexions depuis le serveur (pas seulement depuis votre poste).");
  } finally {
    await db.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// 6. Déploiement en ligne (facultatif) — ce qui ne se voit que de l'extérieur
// ---------------------------------------------------------------------------
if (liveUrl) {
  open("Déploiement en ligne");
  const base = liveUrl.replace(/\/$/, "");
  if (!base.startsWith("https://")) {
    fail("Transport", `${base} n'est pas en https`, "Un jeton de session en clair est un jeton volé. Servez le site en HTTPS avant tout essai réel.");
  }
  try {
    const res = await fetch(base, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (res.status < 400) ok("Site", `${base} répond ${res.status}`);
    else fail("Site", `${base} répond ${res.status}`, "Regardez les journaux du déploiement : l'application a démarré puis s'est arrêtée, ou le build a échoué.");
    const hsts = res.headers.get("strict-transport-security");
    if (hsts) ok("HSTS", hsts);
    else warn("HSTS", "aucun en-tête Strict-Transport-Security", "Route Docker : posé par Caddy (infra/caddy/Caddyfile). Route Replit : posé par la plateforme, à vérifier dans ses réglages de domaine.");
  } catch (e) {
    fail("Site", `${base} injoignable : ${e instanceof Error ? e.message : String(e)}`, "DNS non propagé, certificat non délivré, ou déploiement arrêté.");
  }
  try {
    // Le proxy exige une session AVANT de relayer quoi que ce soit : 401 est la
    // bonne réponse. Un 200 anonyme voudrait dire que l'API est exposée sans
    // authentification, ce qui est pire qu'une panne.
    const res = await fetch(`${base}/api/proxy/ping`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) ok("Accès anonyme", "le proxy refuse une requête sans session (401), comme attendu");
    else if (res.status === 200) fail("Accès anonyme", "le proxy a répondu 200 SANS session : l'API est servie à qui la demande", "Arrêtez le déploiement. Vérifiez AUTH_MODE=oidc et la configuration de session du web.");
    else warn("Accès anonyme", `réponse ${res.status} au lieu de 401`, "Vérifiez que le web sert bien /api/proxy et que l'API tourne derrière lui.");
  } catch (e) {
    warn("Accès anonyme", `contrôle impossible : ${e instanceof Error ? e.message : String(e)}`, "Sans réponse, rien n'est conclu — reprenez après que le site répond.");
  }
} else {
  open("Déploiement en ligne");
  skip("Site publié", "non contrôlé", "pnpm preflight --url https://arcompt.com, une fois publié.");
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
const MARK: Record<Level, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "·" };

console.log("\nARCOMPT — contrôle avant mise en ligne");
console.log("L'environnement est lu comme s'il était en production.\n");

let current = "";
for (const c of checks) {
  if (c.stage !== current) {
    current = c.stage;
    console.log(`── ${current} ${"─".repeat(Math.max(0, 66 - current.length))}`);
  }
  console.log(`${MARK[c.level]} ${c.name} : ${c.detail}`);
  if (c.fix) console.log(`    → ${c.fix}`);
}

const failures = checks.filter((c) => c.level === "fail").length;
const warnings = checks.filter((c) => c.level === "warn").length;
const skipped = checks.filter((c) => c.level === "skip").length;
const passed = checks.filter((c) => c.level === "ok").length;

console.log(`\n${passed} prouvé(s), ${failures} bloquant(s), ${warnings} dégradé(s), ${skipped} non vérifié(s).`);

if (failures > 0) {
  console.log("\nNe publiez pas : chaque ligne ✗ casse ou expose la plateforme. Le geste exact est sous chacune.");
  process.exit(1);
}
if (warnings > 0) {
  console.log("\nPubliable pour un ESSAI. Chaque ligne ⚠ dit ce qui ne fonctionnera pas — relisez-les avant de confier une comptabilité réelle à cette installation.");
} else {
  console.log("\nAucun point bloquant ni dégradé. Restent les lignes · : elles demandent un jeton réel, le compte propriétaire, ou un message reçu.");
}
