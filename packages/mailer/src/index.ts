import { MailError, type Mailer } from "./mailer.js";
import { NullMailer } from "./null-mailer.js";
import { SmtpMailer, smtpOptionsFromEnv } from "./smtp.js";

export * from "./mailer.js";
export * from "./null-mailer.js";
export * from "./smtp.js";
export * from "./templates.js";

/** Opt-out explicite : accepter sciemment de ne rien envoyer en production. */
export const MAIL_OPT_OUT = "ALLOW_INSECURE_MAIL";

/**
 * Garde-fou des replis simulés (voir apps/api/src/config.ts et
 * packages/storage/src/index.ts, même contrat). En production, un repli ne peut
 * être choisi silencieusement : soit la dépendance réelle est configurée, soit
 * l'opt-out `ALLOW_INSECURE_*=1` est posé explicitement. Hors production, on
 * avertit et on continue.
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
    throw new MailError(
      "CONFIG",
      `Configuration de production invalide : ${opts.missing} — sans cela, ${opts.simulated} serait simulé, ce qui est interdit en production.${escape}`,
    );
  }
  warn(`[arcompt] SIMULATION : ${opts.simulated} (${opts.missing}). Jamais en production.`);
}

export interface CreateMailerOptions {
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

/**
 * Transport SMTP si `SMTP_HOST` et `MAIL_FROM_ADDRESS` sont renseignés, sinon
 * expéditeur neutre (rien ne part, tout est journalisé).
 *
 * Le repli neutre est refusé en production, sauf `ALLOW_INSECURE_MAIL=1` : sans
 * ce garde-fou, une invitation au portail, une notification d'accès
 * administrateur ou une relance de règlement seraient enregistrées comme
 * envoyées alors que rien n'aurait quitté le serveur.
 *
 * Le fournisseur n'est pas nommé : n'importe quel service parlant SMTP
 * convient, et changer d'opérateur ne doit toucher que des variables.
 */
export function createMailerFromEnv(opts: CreateMailerOptions = {}): Mailer {
  const env = opts.env ?? process.env;
  const smtp = smtpOptionsFromEnv(env);
  if (smtp) return new SmtpMailer(smtp);
  guardSimulatedDependency({
    env,
    ...(opts.warn ? { warn: opts.warn } : {}),
    simulated:
      "l'envoi des e-mails (invitations au portail, demandes de pièces, notifications d'accès administrateur, relances de règlement : rien ne quitterait le serveur)",
    missing: "SMTP_HOST et MAIL_FROM_ADDRESS sont absents",
    optOut: MAIL_OPT_OUT,
  });
  return new NullMailer(opts.warn ?? ((line: string) => console.warn(line)));
}
