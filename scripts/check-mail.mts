// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Vérifie que l'envoi d'e-mails fonctionne VRAIMENT, avant la première
 * invitation réelle.
 *
 *   pnpm mail:check --to moi@exemple.com
 *   pnpm mail:check --dry                  (configuration et connexion seulement)
 *
 * Pourquoi ce script existe. Un relais mal configuré ne se voit pas : l'API
 * démarre, les écrans fonctionnent, et c'est l'invitation d'un expert-comptable
 * — avec son code à usage unique — qui se perd. Le contrat du module est
 * pourtant strict (packages/portal : rien n'est enregistré comme « envoyé » si
 * l'envoi échoue), mais il ne sert à rien de le découvrir en clientèle.
 *
 * Trois choses sont éprouvées, dans cet ordre, parce qu'elles échouent pour des
 * raisons différentes et qu'un message unique les confondrait :
 *
 *   1. CONFIGURATION — les variables forment un expéditeur cohérent. Une
 *      configuration à moitié posée lève ici, pas au montage des routes.
 *   2. CONNEXION et AUTHENTIFICATION — le serveur répond, le certificat est
 *      accepté, les identifiants passent. C'est l'étape qui attrape le piège
 *      Zoho : une adresse sur domaine propre passe par `smtppro.zoho.com`, et
 *      `smtp.zoho.com` rend une erreur qui ressemble à un mot de passe faux.
 *   3. REMISE — un message part réellement. Une authentification acceptée ne
 *      prouve pas qu'un message sorte : quota, expéditeur refusé ou domaine non
 *      vérifié échouent tous APRÈS l'authentification.
 *
 * Ce que ce script ne peut PAS prouver : que le message arrive en boîte de
 * réception plutôt qu'en indésirables. Cela dépend de SPF, DKIM et DMARC, qui
 * se lisent chez le destinataire — d'où le rappel final, et le message lui-même
 * qui demande d'aller regarder l'en-tête `Authentication-Results`.
 */
import process from "node:process";
import { MailError, SmtpMailer, smtpOptionsFromEnv } from "../packages/mailer/src/index.js";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const to = arg("to");
const dryRun = process.argv.includes("--dry");

if (!to && !dryRun) {
  fail("Destinataire requis : pnpm mail:check --to vous@exemple.com (ou --dry pour la seule connexion)");
}

// --- 1. Configuration ------------------------------------------------------
let options;
try {
  options = smtpOptionsFromEnv();
} catch (e) {
  fail(e instanceof MailError ? e.message : String(e));
}

if (!options) {
  fail("SMTP_HOST est absent : l'expéditeur serait NEUTRE et rien ne quitterait le serveur. Renseignez le bloc SMTP_* (.env.example).");
}

console.log("Configuration lue");
console.log(`  serveur      : ${options.host}:${options.port} (${options.secure ? "TLS dès la connexion" : "STARTTLS"})`);
console.log(`  compte       : ${options.user ?? "(aucune authentification)"}`);
console.log(`  expéditeur   : ${options.fromName ? `${options.fromName} <${options.fromAddress}>` : options.fromAddress}`);
if (options.replyTo) console.log(`  réponse à    : ${options.replyTo}`);

// Zoho refuse d'expédier au nom d'une adresse autre que celle authentifiée. Le
// message d'erreur du serveur ne le dit pas clairement ; autant le voir ici.
if (options.user && options.user.toLowerCase() !== options.fromAddress.toLowerCase()) {
  console.warn(`  ⚠ SMTP_USER (${options.user}) diffère de MAIL_FROM_ADDRESS (${options.fromAddress}).`);
  console.warn("    Certains fournisseurs — Zoho parmi eux — refusent alors l'envoi, APRÈS avoir accepté l'authentification.");
}
if (!options.user || !options.password) {
  console.warn("  ⚠ Sans SMTP_USER et SMTP_PASSWORD, l'envoi n'est possible que si le relais vous authentifie par adresse IP.");
}

const mailer = new SmtpMailer(options);

// --- 2. Connexion et authentification --------------------------------------
console.log("\nConnexion au serveur…");
try {
  await mailer.verify();
  console.log("✓ connexion et authentification acceptées");
} catch (e) {
  console.error(`✗ connexion ou authentification refusée : ${e instanceof Error ? e.message : String(e)}`);
  console.error("\n  Pistes, de la plus fréquente à la plus rare :");
  console.error("   • Adresse sur domaine propre chez Zoho : l'hôte est smtppro.zoho.com, PAS smtp.zoho.com.");
  console.error("   • Suffixe du centre de données : smtppro.zoho.com (US), .eu, .in, .com.au — il se lit dans la console Zoho.");
  console.error("   • Double authentification activée : SMTP_PASSWORD doit être un mot de passe d'application, pas celui de la boîte.");
  console.error("   • Port et chiffrement incohérents : 465 va avec SMTP_SECURE=1, 587 avec STARTTLS.");
  process.exit(1);
}

if (dryRun) {
  console.log("\n--dry : aucun message envoyé. La remise réelle reste à éprouver.");
  process.exit(0);
}

// --- 3. Remise réelle ------------------------------------------------------
const stamp = new Date().toISOString();
console.log(`\nEnvoi d'un message de contrôle à ${to}…`);
try {
  const result = await mailer.send({
    to: to!,
    subject: `ARCOMPT — contrôle d'envoi (${stamp})`,
    text: [
      "Ce message confirme que la plateforme ARCOMPT sait expédier du courrier.",
      "",
      `Expéditeur : ${options.fromAddress}`,
      `Serveur    : ${options.host}:${options.port}`,
      `Émis le    : ${stamp}`,
      "",
      "Il reste UNE chose à vérifier, et elle ne se voit que d'ici :",
      "ouvrez l'en-tête complet de ce message et cherchez « Authentication-Results ».",
      "Il doit porter spf=pass ET dkim=pass. Sans les deux, les invitations au",
      "portail et les relances de règlement partiront en indésirables.",
      "",
      "Si ce message est lui-même arrivé dans les indésirables, c'est déjà la réponse.",
      "",
      "— ARCOMPT, une plateforme ARGILETTE",
    ].join("\n"),
  });
  console.log(`✓ message remis au serveur${result.messageId ? ` (identifiant : ${result.messageId})` : ""}`);
} catch (e) {
  console.error(`✗ le serveur a accepté l'authentification mais REFUSÉ le message : ${e instanceof Error ? e.message : String(e)}`);
  console.error("\n  Ce cas n'est pas un problème d'identifiants. Pistes :");
  console.error("   • Le domaine de l'expéditeur n'est pas encore vérifié chez le fournisseur.");
  console.error("   • L'adresse authentifiée n'a pas le droit d'expédier au nom de MAIL_FROM_ADDRESS.");
  console.error("   • Quota d'envoi atteint (Zoho borne le nombre de messages par jour selon l'offre).");
  process.exit(1);
}

console.log("\nCe qui est prouvé : la configuration, l'authentification, et qu'un message sort.");
console.log("Ce qui ne l'est pas : qu'il arrive en boîte de réception.");
console.log("Ouvrez le message reçu, affichez l'en-tête complet, et exigez spf=pass et dkim=pass");
console.log("(publication des enregistrements : docs/OPERATIONS.md).");
