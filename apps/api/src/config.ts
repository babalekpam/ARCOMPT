/**
 * Configuration de l'API : lecture typée de l'environnement et validation au
 * démarrage.
 *
 * Règle : une installation de production ne démarre JAMAIS sur un simulateur.
 * Tous les replis « démo » (extraction IA hors ligne, antivirus neutre,
 * stockage local, WhatsApp mock, opérateur de paiement mock, connecteur de
 * certification mock) sont interdits quand `NODE_ENV=production`.
 *
 * `loadConfig()` rassemble TOUS les problèmes puis lève une seule `ConfigError`
 * les listant — on ne veut pas corriger une variable par redéploiement. Hors
 * production, les mêmes problèmes sont journalisés en avertissement et
 * l'application continue : le développement local reste inchangé.
 *
 * Chaque simulation tolérée en production doit être choisie explicitement via
 * une variable `ALLOW_INSECURE_*=1` (greppable, jamais accidentelle).
 */

import {
  MockFneConnector,
  MockPaymentProvider,
  NullConnector,
  type CertificationConnector,
  type PaymentProvider,
} from "@arcompt/invoicing";

export type AuthMode = "dev" | "oidc";

/** Variables d'opt-out explicites : accepter sciemment une dépendance simulée en production. */
export const INSECURE_OPT_OUT = {
  ai: "ALLOW_INSECURE_AI",
  storage: "ALLOW_INSECURE_STORAGE",
  antivirus: "ALLOW_INSECURE_ANTIVIRUS",
  whatsapp: "ALLOW_INSECURE_WHATSAPP",
} as const;

/** Longueur minimale raisonnable pour un secret HMAC de webhook de paiement. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** Secret de démonstration historique : interdit partout, il rendait les webhooks signables par n'importe qui. */
export const FORBIDDEN_WEBHOOK_SECRET = "mock-secret";

/** Nom réservé au simulateur d'encaissement : interdit en production. */
export const MOCK_PAYMENT_PROVIDER = "mock";

const PAYROLL_KEY_BYTES = 32;

/** Erreur de configuration : porte la liste complète des problèmes détectés. */
export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      `Configuration de production invalide : ${problems.length} problème(s) bloquant(s).\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.problems = [...problems];
  }
}

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  appUrl: string;
  baseCurrency: string;
  databaseUrl?: string;
  auth: { mode: AuthMode; issuer?: string; audience?: string };
  ai: { apiKey?: string; model?: string; simulated: boolean };
  storage: { driver: "r2" | "local" };
  antivirus: { driver: "clamav" | "none" };
  whatsapp: { simulated: boolean; appSecret?: string };
  payments: { provider: string; enabled: boolean; simulated: boolean; webhookSecret?: string };
  certification: { connector: string; simulated: boolean };
  /** Simulations explicitement autorisées (ALLOW_INSECURE_*). */
  insecure: { ai: boolean; storage: boolean; antivirus: boolean; whatsapp: boolean };
  /** Problèmes détectés ; toujours vide en production (sinon `loadConfig` aurait levé). */
  problems: readonly string[];
  /**
   * Fonctions volontairement hors service faute de connecteur réel. Elles
   * n'empêchent pas le démarrage : la fonction est coupée, jamais simulée.
   * À journaliser au démarrage pour que l'exploitant sache ce qui manque.
   */
  degraded: readonly string[];
}

export interface LoadConfigOptions {
  warn?: (message: string) => void;
}

/** `1`, `true`, `yes` (insensible à la casse) activent un opt-out ; tout le reste le laisse fermé. */
export function isOptOutEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Vrai si la valeur est un base64 décodant exactement `bytes` octets. */
function isBase64OfLength(value: string, bytes: number): boolean {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return false;
  try {
    return Buffer.from(trimmed, "base64").length === bytes;
  } catch {
    return false;
  }
}

function r2Configured(env: NodeJS.ProcessEnv): boolean {
  return present(env.R2_ACCOUNT_ID) && present(env.R2_ACCESS_KEY_ID) && present(env.R2_SECRET_ACCESS_KEY) && present(env.R2_BUCKET);
}

/**
 * Charge et valide la configuration.
 *
 * En production : lève `ConfigError` listant tous les problèmes.
 * Hors production : journalise un avertissement par problème et renvoie la
 * configuration telle quelle (comportement local inchangé).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): AppConfig {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const isProduction = env.NODE_ENV === "production";
  const problems: string[] = [];
  const degraded: string[] = [];

  const insecure = {
    ai: isOptOutEnabled(env[INSECURE_OPT_OUT.ai]),
    storage: isOptOutEnabled(env[INSECURE_OPT_OUT.storage]),
    antivirus: isOptOutEnabled(env[INSECURE_OPT_OUT.antivirus]),
    whatsapp: isOptOutEnabled(env[INSECURE_OPT_OUT.whatsapp]),
  };

  // --- Base de données ------------------------------------------------------
  if (!present(env.DATABASE_URL)) problems.push("DATABASE_URL : absent — aucune base de données à laquelle se connecter.");

  // --- Authentification -----------------------------------------------------
  const mode: AuthMode = env.AUTH_MODE === "oidc" ? "oidc" : "dev";
  if (mode !== "oidc") {
    problems.push("AUTH_MODE : doit valoir « oidc » en production — le mode « dev » accepte l'en-tête X-Tenant-Id sans jeton.");
  }
  if (!present(env.KEYCLOAK_ISSUER)) problems.push("KEYCLOAK_ISSUER : absent — aucun émetteur de jetons à vérifier.");
  if (!present(env.KEYCLOAK_CLIENT_ID)) problems.push("KEYCLOAK_CLIENT_ID : absent — audience des jetons non vérifiable.");

  // --- Paiements ------------------------------------------------------------
  // Aucun opérateur réel n'est encore implémenté. Deux situations distinctes :
  //  - variable absente : l'encaissement mobile money est hors service. Une PME
  //    facture et tient sa comptabilité sans lui ; couper tout le service serait
  //    disproportionné. Démarrage autorisé, routes de paiement non montées.
  //  - PAYMENT_PROVIDER=mock : on réclame un simulateur qui accepte des
  //    encaissements fictifs. Refus de démarrer, sans opt-out.
  const paymentProvider = present(env.PAYMENT_PROVIDER) ? env.PAYMENT_PROVIDER.trim() : "";
  const paymentsRequested = paymentProvider !== "";
  // « Simulé » décrit ce qui sera réellement servi : le mock explicitement
  // demandé, ou, hors production, le repli local quand rien n'est configuré.
  const paymentsSimulated = paymentProvider === MOCK_PAYMENT_PROVIDER || (!paymentsRequested && !isProduction);
  if (paymentProvider === MOCK_PAYMENT_PROVIDER) {
    problems.push(
      `PAYMENT_PROVIDER : vaut « ${MOCK_PAYMENT_PROVIDER} » — l'opérateur simulé accepte des encaissements fictifs et laisse signer un webhook « payé ». Configurez un opérateur réel, ou laissez la variable vide pour désactiver l'encaissement.`,
    );
  } else if (!paymentsRequested) {
    degraded.push("Encaissement mobile money désactivé : PAYMENT_PROVIDER est absent, aucun lien de paiement ni webhook n'est monté.");
  }

  // Le secret de webhook n'a de sens que si un opérateur est configuré.
  const webhookSecret = env.PAYMENT_WEBHOOK_SECRET;
  if (paymentsRequested) {
    if (!present(webhookSecret)) {
      problems.push("PAYMENT_WEBHOOK_SECRET : absent — les webhooks de paiement ne seraient plus authentifiés.");
    } else if (webhookSecret.trim() === FORBIDDEN_WEBHOOK_SECRET) {
      problems.push(
        `PAYMENT_WEBHOOK_SECRET : vaut « ${FORBIDDEN_WEBHOOK_SECRET} » — ce secret de démonstration permet à quiconque de signer un événement « payé ».`,
      );
    } else if (webhookSecret.trim().length < MIN_WEBHOOK_SECRET_LENGTH) {
      problems.push(`PAYMENT_WEBHOOK_SECRET : trop court (${MIN_WEBHOOK_SECRET_LENGTH} caractères minimum attendus).`);
    }
  }

  // --- Facture certifiée ----------------------------------------------------
  const certificationConnector = present(env.CERTIFICATION_CONNECTOR) ? env.CERTIFICATION_CONNECTOR.trim() : "none";
  const certificationSimulated = certificationConnector === "mock";
  if (certificationSimulated) {
    problems.push(
      "CERTIFICATION_CONNECTOR : vaut « mock » — une référence de certification fiscale et un QR code inventés seraient imprimés sur les factures clients.",
    );
  }

  // --- Paie -----------------------------------------------------------------
  const payrollKey = env.PAYROLL_ENCRYPTION_KEY;
  if (!present(payrollKey)) {
    problems.push("PAYROLL_ENCRYPTION_KEY : absente — les données de paie seraient chiffrées avec une clé de développement déterministe.");
  } else if (!isBase64OfLength(payrollKey, PAYROLL_KEY_BYTES)) {
    problems.push(`PAYROLL_ENCRYPTION_KEY : base64 de ${PAYROLL_KEY_BYTES} octets attendu.`);
  }

  // --- Passerelle IA --------------------------------------------------------
  const aiSimulated = !present(env.ANTHROPIC_API_KEY);
  if (aiSimulated && !insecure.ai) {
    problems.push(
      `ANTHROPIC_API_KEY : absente — l'extraction des pièces serait simulée (fournisseur « Fournisseur démo », montants inventés) et alimenterait la file de validation. Posez ${INSECURE_OPT_OUT.ai}=1 pour l'accepter explicitement.`,
    );
  }

  // --- Stockage des pièces --------------------------------------------------
  const storageDriver: "r2" | "local" = r2Configured(env) ? "r2" : "local";
  if (storageDriver === "local" && !insecure.storage) {
    problems.push(
      `R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET : stockage objet non configuré — les pièces à conservation décennale atterriraient sur le disque éphémère du conteneur. Posez ${INSECURE_OPT_OUT.storage}=1 pour l'accepter explicitement.`,
    );
  }

  // --- Antivirus ------------------------------------------------------------
  const antivirusDriver: "clamav" | "none" = present(env.CLAMAV_HOST) ? "clamav" : "none";
  if (antivirusDriver === "none" && !insecure.antivirus) {
    problems.push(
      `CLAMAV_HOST : absent — l'antivirus serait neutre et accepterait tous les fichiers téléversés. Posez ${INSECURE_OPT_OUT.antivirus}=1 pour l'accepter explicitement.`,
    );
  }

  // --- WhatsApp -------------------------------------------------------------
  const whatsappSimulated = !(present(env.WHATSAPP_TOKEN) && present(env.WHATSAPP_PHONE_ID));
  if (whatsappSimulated && !insecure.whatsapp) {
    problems.push(
      `WHATSAPP_TOKEN / WHATSAPP_PHONE_ID : absents — le canal WhatsApp serait simulé et avalerait silencieusement tous les messages sortants. Posez ${INSECURE_OPT_OUT.whatsapp}=1 pour l'accepter explicitement.`,
    );
  }
  if (!present(env.WHATSAPP_APP_SECRET)) {
    problems.push("WHATSAPP_APP_SECRET : absent — la signature HMAC des webhooks Meta ne serait pas vérifiée.");
  }

  if (isProduction && problems.length > 0) throw new ConfigError(problems);
  for (const p of problems) warn(`[arcompt] configuration non conforme à la production : ${p}`);

  const port = Number(env.API_PORT ?? 4000);
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    isProduction,
    port: Number.isFinite(port) && port > 0 ? port : 4000,
    appUrl: env.APP_URL ?? "http://localhost:3000",
    baseCurrency: env.DEFAULT_CURRENCY ?? "XOF",
    ...(present(env.DATABASE_URL) ? { databaseUrl: env.DATABASE_URL } : {}),
    auth: {
      mode,
      ...(present(env.KEYCLOAK_ISSUER) ? { issuer: env.KEYCLOAK_ISSUER } : {}),
      ...(present(env.KEYCLOAK_CLIENT_ID) ? { audience: env.KEYCLOAK_CLIENT_ID } : {}),
    },
    ai: {
      ...(present(env.ANTHROPIC_API_KEY) ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      ...(present(env.AI_MODEL) ? { model: env.AI_MODEL } : {}),
      simulated: aiSimulated,
    },
    storage: { driver: storageDriver },
    antivirus: { driver: antivirusDriver },
    whatsapp: {
      simulated: whatsappSimulated,
      ...(present(env.WHATSAPP_APP_SECRET) ? { appSecret: env.WHATSAPP_APP_SECRET } : {}),
    },
    payments: {
      provider: paymentProvider,
      enabled: paymentsRequested,
      simulated: paymentsSimulated,
      ...(present(webhookSecret) ? { webhookSecret } : {}),
    },
    certification: { connector: certificationConnector, simulated: certificationSimulated },
    insecure,
    problems,
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Garde-fou des points de repli
// ---------------------------------------------------------------------------

export interface SimulationGuardOptions {
  /** Ce qui serait simulé, en clair (ex. « l'extraction IA des pièces »). */
  simulated: string;
  /** Variable(s) manquante(s) ou valeur fautive à l'origine du repli. */
  missing: string;
  /** Variable d'opt-out explicite (ALLOW_INSECURE_*) ; absente = repli interdit en production. */
  optOut?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

/**
 * Garde-fou à poser à chaque point de repli vers un simulateur.
 * En production : lève, en nommant la variable manquante et ce qui serait
 * simulé (sauf opt-out explicite). Ailleurs : avertit et laisse passer.
 */
export function guardSimulatedDependency(opts: SimulationGuardOptions): void {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const allowed = opts.optOut ? isOptOutEnabled(env[opts.optOut]) : false;
  if (env.NODE_ENV === "production" && !allowed) {
    const escape = opts.optOut ? ` Posez ${opts.optOut}=1 pour l'accepter explicitement.` : "";
    throw new ConfigError([`${opts.missing} — sans cela, ${opts.simulated} serait simulé, ce qui est interdit en production.${escape}`]);
  }
  warn(`[arcompt] SIMULATION : ${opts.simulated} (${opts.missing}). Jamais en production.`);
}

/**
 * Opérateurs de paiement mobile money. `MockPaymentProvider` est aujourd'hui la
 * seule implémentation : elle fabrique des encaissements fictifs.
 *
 * En production, la simulation n'est jamais servie. Deux cas :
 *  - `PAYMENT_PROVIDER=mock` : on réclame le simulateur, donc refus net ;
 *  - variable absente : aucun opérateur réel n'existant encore, la fonction est
 *    coupée (map vide, routes de paiement non montées) plutôt que simulée. Le
 *    reste de la plateforme — tenue, facturation, états — démarre normalement.
 *
 * Le repli historique `?? "mock-secret"` est supprimé : un secret de webhook
 * deviné laissait signer un événement « payé ». Hors production, si
 * `PAYMENT_WEBHOOK_SECRET` est absent, on avertit et on laisse le mock utiliser
 * son propre secret de démonstration (comportement local inchangé).
 */
export function paymentProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): Record<string, PaymentProvider> {
  const requested = present(env.PAYMENT_PROVIDER) ? env.PAYMENT_PROVIDER.trim() : "";
  if (env.NODE_ENV === "production") {
    // `mock` réclamé explicitement : refus net, sans opt-out.
    if (requested === MOCK_PAYMENT_PROVIDER) {
      throw new ConfigError([
        `PAYMENT_PROVIDER vaut « ${MOCK_PAYMENT_PROVIDER} » — l'opérateur simulé accepte des encaissements fictifs, ce qui est interdit en production.`,
      ]);
    }
    // Aucun opérateur réel n'existe encore : la fonction est coupée, pas
    // simulée. Le reste de la plateforme démarre normalement.
    warn("[arcompt] DÉGRADÉ : aucun opérateur de paiement réel n'est configuré, l'encaissement mobile money est hors service.");
    return {};
  }
  const secret = env.PAYMENT_WEBHOOK_SECRET;
  warn("[arcompt] SIMULATION : opérateur de paiement mobile money simulé (encaissements fictifs). Jamais en production.");
  if (!present(secret)) {
    warn(`[arcompt] SIMULATION : PAYMENT_WEBHOOK_SECRET est absent, le secret de démonstration de MockPaymentProvider est utilisé. Jamais en production.`);
  } else if (secret.trim() === FORBIDDEN_WEBHOOK_SECRET) {
    warn(`[arcompt] SIMULATION : PAYMENT_WEBHOOK_SECRET vaut « ${FORBIDDEN_WEBHOOK_SECRET} », un secret public. Jamais en production.`);
  }
  return { mock: new MockPaymentProvider({ ...(present(secret) ? { secret } : {}) }) };
}

/**
 * Connecteur de facture certifiée (FNE/MECeF). `CERTIFICATION_CONNECTOR=mock`
 * fabrique une référence fiscale et un QR code imprimés sur la facture client :
 * interdit en production, sans opt-out. Toute autre valeur donne `NullConnector`
 * (aucune certification, rien d'inventé).
 */
export function certificationConnectorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): CertificationConnector {
  if (env.CERTIFICATION_CONNECTOR !== "mock") return new NullConnector();
  guardSimulatedDependency({
    env,
    warn,
    simulated: "la certification fiscale des factures (référence et QR code inventés, imprimés sur la facture client)",
    missing: "CERTIFICATION_CONNECTOR vaut « mock »",
  });
  return new MockFneConnector();
}
