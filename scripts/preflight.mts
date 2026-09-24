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
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ConfigError, loadConfig } from "../apps/api/src/config.js";
import { assertProductionDatabaseSecurity } from "../apps/api/src/database-readiness.js";
import { assertDistinctDatabaseUrls, assertProductionQueueDatabaseSecurity } from "../apps/api/src/queue-database.js";
import { MailError, SmtpMailer, smtpOptionsFromEnv } from "../packages/mailer/src/index.js";
import { createDb } from "../packages/db/src/client.js";
import { parseClerkHosting } from "../apps/web/lib/clerk-hosting.js";

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
    if (isSimulated && (name === "Stockage des pièces" || name === "Antivirus")) {
      fail(name, `simulé ou neutre. ${consequence}`, "Renseignez le service réel ; les dérogations ALLOW_INSECURE_STORAGE et ALLOW_INSECURE_ANTIVIRUS ne sont pas publiables.");
    } else if (isSimulated) {
      warn(name, `simulé ou neutre. ${consequence}`, "Renseignez le service réel ; l'opt-out ALLOW_INSECURE_* ne fait que rendre la décision explicite.");
    }
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
// 4. Identité — Clerk géré par Replit ou tenant externe
// ---------------------------------------------------------------------------
open("Identité");

const authMode = (env.AUTH_MODE ?? "").trim();
if (authMode !== "clerk") {
  fail("Mode d'authentification", `AUTH_MODE=« ${authMode || "(vide)"} » : seul Clerk vérifie les sessions de production ; le mode dev accepte l'en-tête X-Tenant-Id SANS jeton`, "AUTH_MODE=clerk, avec les clés Clerk et CLERK_AUTHORIZED_PARTIES renseignés.");
} else {
  ok("Mode d'authentification", "AUTH_MODE=clerk : l'API n'accepte pas le mode dev en production");
}

const clerkSecret = env.CLERK_SECRET_KEY?.trim();
const clerkPublishable = (env.CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? env.VITE_CLERK_PUBLISHABLE_KEY)?.trim();
const authorizedParties = (env.CLERK_AUTHORIZED_PARTIES ?? env.APP_URL ?? "")
  .split(",").map((v) => v.trim()).filter(Boolean);
let clerkHosting: ReturnType<typeof parseClerkHosting> | null = null;

try {
  clerkHosting = parseClerkHosting(env.CLERK_HOSTING);
  ok("Hébergement Clerk", clerkHosting === "external"
    ? "tenant externe : le navigateur contacte directement la Frontend API portée par la clé publique, sans proxy Replit"
    : "géré par Replit : le proxy même origine reste actif en production");
} catch (e) {
  fail("Hébergement Clerk", e instanceof Error ? e.message : String(e), 'Posez CLERK_HOSTING=managed ou CLERK_HOSTING=external. Une valeur inconnue bloque aussi le build Next.js.');
}

if (!clerkSecret) {
  fail(
    "Clé secrète Clerk",
    "CLERK_SECRET_KEY absent",
    clerkHosting === "external"
      ? "Injectez la clé secrète du tenant Clerk externe dans l'environnement de production ; ne l'imprimez jamais."
      : "Laissez Replit-managed Clerk provisionner CLERK_SECRET_KEY dans l'environnement de production ; ne l'imprimez jamais.",
  );
} else {
  ok("Clé secrète Clerk", "CLERK_SECRET_KEY est présente (valeur non affichée)");
}
if (!clerkPublishable) {
  fail(
    "Clé publique Clerk",
    "CLERK_PUBLISHABLE_KEY (ou VITE_CLERK_PUBLISHABLE_KEY) absent",
    clerkHosting === "external"
      ? "Renseignez la clé publique du tenant externe dont la Frontend API est clerk.arcompt.com."
      : "Vérifiez que Replit-managed Clerk a provisionné la clé publique du web ; cette clé n'est pas un secret.",
  );
} else {
  ok("Clé publique Clerk", "la clé publique du web est présente (valeur non affichée)");
}
if (authorizedParties.length === 0) {
  fail("Origine autorisée Clerk", "CLERK_AUTHORIZED_PARTIES et APP_URL sont absents", "Renseignez l'origine HTTPS canonique du web, par exemple CLERK_AUTHORIZED_PARTIES=https://arcompt.com.");
} else if (authorizedParties.some((origin) => !origin.startsWith("https://") && !origin.startsWith("http://localhost"))) {
  fail("Origine autorisée Clerk", `valeur non HTTPS ou non locale : ${authorizedParties.join(", ")}`, "N'autorisez en production que l'origine HTTPS canonique du web ; localhost est réservé au développement.");
} else {
  ok("Origine autorisée Clerk", `${authorizedParties.length} origine(s) déclarée(s), valeur(s) non sensible(s)`);
}
skip(
  "Session Clerk réelle",
  "non vérifiable sans connexion interactive : signature, expiration, sujet Clerk, email vérifié et éventuel second facteur",
  "Après déploiement, connectez-vous avec un compte Clerk, vérifiez la récupération de mot de passe, puis testez un OWNER/MFA et un utilisateur sans accès au dossier d'un autre tenant.",
);
if (clerkHosting === "external") {
  skip(
    "Frontend API Clerk externe",
    "le build omet tout proxy Clerk ; l'accessibilité de la Frontend API du tenant portée par la clé publique n'a pas été vérifiée ici",
    "Après déploiement, confirmez dans le navigateur que Clerk contacte directement clerk.arcompt.com, puis testez connexion, cookies et récupération de mot de passe.",
  );
} else if (clerkHosting === "managed") {
  skip(
    "Proxy Clerk en production",
    "Next.js utilise /api/__clerk au build de production ; le chargement du navigateur et les cookies n'ont pas été vérifiés ici",
    "Après déploiement, confirmez que /api/__clerk sert la Frontend API Clerk et que la connexion fonctionne via ce chemin, sans exposer CLERK_SECRET_KEY.",
  );
}

// ---------------------------------------------------------------------------
// 5. Base de données — isolation, droits, migrations
// ---------------------------------------------------------------------------
open("Base de données");

const appDbUrl = env.APP_DATABASE_URL?.trim();
const queueDbUrl = env.QUEUE_DATABASE_URL?.trim();
if (!appDbUrl) {
  fail("Connexion applicative", "APP_DATABASE_URL absent ; DATABASE_URL n'est jamais utilisé comme repli", "Fournissez une connexion dédiée au rôle applicatif restreint, distincte du compte propriétaire géré.");
} else {
  const db = createDb({ url: appDbUrl, max: 1 });
  try {
    await assertProductionDatabaseSecurity(db);
    ok("Connexion applicative", "APP_DATABASE_URL répond avec un rôle restreint ; RLS, politiques, fonctions sécurisées et droits SQL sont conformes");
    skip("Historique des migrations", "schema_migration n'est volontairement jamais interrogée avec le rôle applicatif", "Vérifiez l'étape de migration dans le journal de livraison contrôlé, séparément du runtime de production.");
  } catch {
    fail("Connexion applicative", "connexion impossible ou contrôle de sécurité refusé (aucun détail de connexion n'est affiché)", "Corrigez APP_DATABASE_URL ou le modèle de droits avant publication ; ne remplacez pas cette URL par la connexion propriétaire.");
  } finally {
    await db.end({ timeout: 5 });
  }
}

if (!env.REDIS_URL?.trim()) {
  if (!queueDbUrl) {
    fail("Connexion de file", "QUEUE_DATABASE_URL absent sans REDIS_URL", "Fournissez une connexion dédiée au rôle arcompt_queue, distincte des connexions propriétaire et applicative.");
  } else if (!appDbUrl) {
    fail("Connexion de file", "le rôle de file ne peut pas être comparé au rôle applicatif sans APP_DATABASE_URL", "Fournissez d'abord les deux connexions runtime restreintes.");
  } else {
    try {
      assertDistinctDatabaseUrls(appDbUrl, queueDbUrl);
      const appDb = createDb({ url: appDbUrl, max: 1 });
      const queueDb = createDb({ url: queueDbUrl, max: 1 });
      try {
        await assertProductionQueueDatabaseSecurity(queueDb, appDb);
        ok("Connexion de file", "QUEUE_DATABASE_URL répond avec un rôle dédié, distinct du rôle applicatif et limité aux fonctions de file");
      } finally {
        await queueDb.end({ timeout: 5 });
        await appDb.end({ timeout: 5 });
      }
    } catch {
      fail("Connexion de file", "connexion impossible ou contrôle de sécurité refusé (aucun détail de connexion n'est affiché)", "Corrigez QUEUE_DATABASE_URL ou les droits du rôle de file ; aucune connexion propriétaire ou applicative ne doit la remplacer.");
    }
  }
} else {
  ok("Connexion de file", "REDIS_URL est configurée ; aucune connexion PostgreSQL de file n'est utilisée");
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
    else if (res.status === 200) fail("Accès anonyme", "le proxy a répondu 200 SANS session : l'API est servie à qui la demande", "Arrêtez le déploiement. Vérifiez AUTH_MODE=clerk et la configuration de session du web.");
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
