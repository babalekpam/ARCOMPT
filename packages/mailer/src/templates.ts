import { MailError } from "./mailer.js";

/**
 * Modèles de messages, en français, vouvoiement.
 *
 * Trois règles tenues par tous les modèles :
 *  1. le corps en texte brut est la version de référence ; le HTML en est
 *     dérivé mécaniquement (`htmlFromText`) et ne porte rien de plus, donc un
 *     client qui n'affiche que le texte ne perd aucune information ;
 *  2. chaque message dit POURQUOI son destinataire le reçoit — un client d'une
 *     PME qui reçoit une demande de pièce n'a jamais entendu parler d'ARCOMPT ;
 *  3. chaque message se termine par les mentions légales de l'expéditeur
 *     (`MAIL_LEGAL_FOOTER`), qui ne sont pas connues du code.
 *
 * Ton : celui d'un cabinet, pas d'une campagne. Pas d'emoji, pas de
 * superlatif, pas d'injonction. Une relance de niveau 3 reste polie.
 */

/** Message rendu, prêt pour le `Mailer`. */
export interface RenderedMail {
  subject: string;
  text: string;
  /** Toujours produit à partir du texte : il s'y réduit sans perte. */
  html: string;
}

/** Mentions légales à faire figurer en pied de message (raison sociale, adresse, RCCM, contact). */
export const LEGAL_FOOTER_ENV = "MAIL_LEGAL_FOOTER";

/**
 * Pied de page servi tant que `MAIL_LEGAL_FOOTER` n'est pas renseigné. Il est
 * volontairement explicite : un message parti avec ce texte se remarque à la
 * première lecture, au lieu de partir sans mentions du tout.
 */
export const DEFAULT_LEGAL_FOOTER = `Mentions légales de l'expéditeur non renseignées (${LEGAL_FOOTER_ENV}).`;

/** Mentions légales configurées, ou le texte de rappel ci-dessus. */
export function legalFooterFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[LEGAL_FOOTER_ENV]?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_LEGAL_FOOTER;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Remplace les `{{variable}}` d'un gabarit.
 *
 * Lève si une variable manque, est vide, ou si un `{{` subsiste après
 * substitution : mieux vaut refuser d'envoyer que de remettre au client d'une
 * PME un message où s'affiche « {{numero_facture}} ».
 */
export function fill(template: string, vars: Record<string, string | number | undefined>): string {
  const missing: string[] = [];
  const out = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || String(value).trim() === "") {
      missing.push(name);
      return "";
    }
    return String(value);
  });
  if (missing.length > 0) {
    throw new MailError("TEMPLATE", `Variables de modèle absentes : ${[...new Set(missing)].join(", ")}.`, { missing });
  }
  if (/\{\{|\}\}/.test(out)) {
    throw new MailError("TEMPLATE", "Un marqueur de modèle n'a pas été remplacé.", { rendered: out.slice(0, 200) });
  }
  return out;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * HTML dérivé du texte : échappement, un paragraphe par ligne vide, sauts de
 * ligne conservés, adresses http(s) rendues cliquables. Le HTML ne dit donc
 * jamais rien que le texte ne dise pas.
 */
export function htmlFromText(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => linkify(escapeHtml(line)))
        .join("<br />"),
    )
    .map((block) => `<p>${block}</p>`)
    .join("\n");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8" /></head>
<body style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">
${paragraphs}
</body></html>`;
}

/** Les URL sont échappées AVANT d'arriver ici : on ne relit que du HTML sûr. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
}

/** Corps commun : le message, puis pourquoi il est reçu, puis les mentions légales. */
function compose(input: { subject: string; body: string; reason: string; legalFooter: string }): RenderedMail {
  const text = `${input.body.trim()}\n\n--\n${input.reason.trim()}\n${input.legalFooter.trim()}\n`;
  return { subject: input.subject, text, html: htmlFromText(text) };
}

// ---------------------------------------------------------------------------
// Date et montants
// ---------------------------------------------------------------------------

/** « 2025-06-01 » ou un horodatage ISO → « 01/06/2025 ». */
export function formatDateFr(value: string): string {
  const d = value.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return value;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Horodatage ISO → « 01/06/2025 à 12:00 UTC » ; le fuseau est dit, jamais supposé. */
export function formatDateTimeFr(value: string): string {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return value;
  const iso = t.toISOString();
  return `${formatDateFr(iso)} à ${iso.slice(11, 16)} UTC`;
}

/** « 120000.0000 » + « XOF » → « 120 000,00 XOF » (espace insécable, virgule décimale). */
export function formatAmountFr(amount: string | number, currency: string): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  const [whole = "0", cents = "00"] = n.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return `${grouped},${cents}\u00a0${currency}`;
}

// ---------------------------------------------------------------------------
// Invitation au portail
// ---------------------------------------------------------------------------

export const MEMBER_ROLE_LABELS: Record<string, string> = {
  OWNER: "dirigeant",
  ACCOUNTANT: "comptable",
  CASHIER: "caissier",
  AUDITOR: "auditeur",
  REVIEWER: "réviseur",
};

export interface InvitationMailVars {
  /** Organisation qui invite (cabinet ou groupe). */
  organizationName: string;
  /** Rôle attribué (clé de MEMBER_ROLE_LABELS ; la clé brute est utilisée si inconnue). */
  role: string;
  /** Nombre de dossiers ouverts par l'invitation. */
  companyCount: number;
  /** Page d'acceptation de l'invitation. */
  acceptUrl: string;
  /** Code à usage unique, à recopier dans le formulaire d'acceptation. */
  token: string;
  /** Fin de validité (ISO). */
  expiresAt: string;
  legalFooter: string;
}

/**
 * Invitation : elle porte le lien ET le code à usage unique. Le lien transporte
 * le code dans son fragment, que le formulaire lit et préremplit sans que ce
 * code ne parte vers aucun serveur. Le code reste écrit en clair dans le
 * message, pour qui ouvre le lien sur un autre appareil ou préfère le recopier.
 */
export function invitationMail(v: InvitationMailVars): RenderedMail {
  const vars = {
    ...v,
    roleLabel: MEMBER_ROLE_LABELS[v.role] ?? v.role,
    dossiers: v.companyCount > 1 ? `${v.companyCount} dossiers` : "1 dossier",
    expiresOn: formatDateTimeFr(v.expiresAt),
  };
  return compose({
    subject: fill("Invitation à rejoindre {{organizationName}} sur ARCOMPT", vars),
    body: fill(
      `Bonjour,

{{organizationName}} vous invite à accéder à sa comptabilité sur ARCOMPT, avec le rôle de {{roleLabel}}, sur {{dossiers}}.

Pour accepter l'invitation, ouvrez le lien ci-dessous et connectez-vous : le code sera déjà rempli dans le formulaire « Accepter une invitation ».

{{acceptUrl}}

Si vous ouvrez ce lien depuis un autre appareil, recopiez ce code dans le formulaire.

Code d'invitation : {{token}}

Ce code est à usage unique et cesse d'être valable le {{expiresOn}}. Ne le transmettez à personne : il donne accès aux dossiers concernés.

Si vous n'attendiez pas cette invitation, ignorez ce message ; le code expirera sans avoir servi.`,
      vars,
    ),
    reason: fill("Vous recevez ce message parce que {{organizationName}} a saisi votre adresse pour vous donner accès à sa comptabilité.", vars),
    legalFooter: v.legalFooter,
  });
}

// ---------------------------------------------------------------------------
// Demande de pièce manquante
// ---------------------------------------------------------------------------

export interface MissingDocumentMailVars {
  /** Nom du destinataire (tiers), s'il est connu. */
  partnerName?: string;
  /** Expéditeur affiché : cabinet en marque blanche, ou nom du dossier. */
  senderName: string;
  /** Dossier concerné. */
  companyName: string;
  /** Pièce demandée, telle que saisie. */
  description: string;
  legalFooter: string;
}

export function missingDocumentMail(v: MissingDocumentMailVars): RenderedMail {
  const vars = { ...v, greeting: v.partnerName ? `Bonjour ${v.partnerName},` : "Bonjour," };
  return compose({
    subject: fill("{{senderName}} : pièce manquante pour {{companyName}}", vars),
    body: fill(
      `{{greeting}}

{{senderName}} a besoin de la pièce suivante pour le dossier {{companyName}} :

{{description}}

Merci de la transmettre en réponse à ce message, de préférence au format PDF ou en photographie lisible.

Si vous l'avez déjà envoyée, ce message peut se croiser avec votre envoi ; dans ce cas, n'en tenez pas compte.`,
      vars,
    ),
    reason: fill("Vous recevez ce message parce que {{senderName}} tient la comptabilité du dossier {{companyName}} et a besoin de cette pièce pour la justifier.", vars),
    legalFooter: v.legalFooter,
  });
}

// ---------------------------------------------------------------------------
// Accès d'un administrateur au dossier
// ---------------------------------------------------------------------------

export interface AdminAccessMailVars {
  /** Dossier consulté. */
  companyName: string;
  /** Date et heure de l'accès (ISO). */
  accessedAt: string;
  /** Motif saisi par l'administrateur. */
  reason: string;
  legalFooter: string;
}

/** Notification d'un accès technique ordinaire, journalisé et consultable. */
export function adminAccessMail(v: AdminAccessMailVars): RenderedMail {
  const vars = { ...v, accessedOn: formatDateTimeFr(v.accessedAt) };
  return compose({
    subject: fill("Accès technique à votre dossier {{companyName}}", vars),
    body: fill(
      `Bonjour,

Nous vous informons qu'un technicien a accédé à votre dossier {{companyName}} le {{accessedOn}}.

Motif indiqué : {{reason}}

Cet accès est journalisé et consultable à tout moment dans votre portail, à la rubrique « Accès administrateur ». Il ne permet aucune modification de vos écritures validées, que la plateforme rend inaltérables.

Si cet accès vous paraît injustifié, répondez à ce message : nous vous en rendrons compte.`,
      vars,
    ),
    reason: fill("Vous recevez ce message parce que vous êtes dirigeant du dossier {{companyName}} et que tout accès technique à un dossier vous est notifié.", vars),
    legalFooter: v.legalFooter,
  });
}

export interface BreakGlassMailVars extends AdminAccessMailVars {
  /** Fin de validité de l'accès d'urgence (ISO). */
  expiresAt: string;
}

/**
 * Notification d'un accès d'urgence (break-glass) : même fait, gravité
 * différente. Le message dit qu'un second administrateur a approuvé et quand
 * l'accès prend fin, parce que c'est ce qui permet au dirigeant de contrôler.
 */
export function breakGlassMail(v: BreakGlassMailVars): RenderedMail {
  const vars = { ...v, accessedOn: formatDateTimeFr(v.accessedAt), expiresOn: formatDateTimeFr(v.expiresAt) };
  return compose({
    subject: fill("Accès d'urgence à votre dossier {{companyName}}", vars),
    body: fill(
      `Bonjour,

Nous vous informons qu'un technicien a accédé à votre dossier {{companyName}} le {{accessedOn}} au titre d'un accès d'urgence.

Motif indiqué : {{reason}}

Un accès d'urgence est demandé par un administrateur, approuvé par un second, limité dans le temps et intégralement audité. Celui-ci prend fin le {{expiresOn}}.

Le détail figure dans votre portail, aux rubriques « Accès administrateur » et « Accès d'urgence ». Si cet accès vous paraît injustifié, répondez à ce message sans attendre.`,
      vars,
    ),
    reason: fill("Vous recevez ce message parce que vous êtes dirigeant du dossier {{companyName}} et que tout accès d'urgence vous est notifié.", vars),
    legalFooter: v.legalFooter,
  });
}

// ---------------------------------------------------------------------------
// Relances de règlement
// ---------------------------------------------------------------------------

export interface DunningMailVars {
  /** 1 = rappel, 2 = relance, 3 et au-delà = mise en demeure. */
  level: number;
  /** Client relancé. */
  partnerName: string;
  /** Émetteur de la facture (le dossier). */
  companyName: string;
  invoiceNumber: string;
  /** Échéance dépassée (ISO). */
  dueDate: string;
  daysOverdue: number;
  /** Reste dû, décimal. */
  outstanding: string;
  currency: string;
  /** Mot ajouté par le cabinet, facultatif. */
  message?: string;
  legalFooter: string;
}

const DUNNING_SUBJECTS: Record<number, string> = {
  1: "Rappel : facture {{invoiceNumber}} échue",
  2: "Relance : facture {{invoiceNumber}} toujours impayée",
  3: "Mise en demeure : facture {{invoiceNumber}}",
};

const DUNNING_BODIES: Record<number, string> = {
  1: `Bonjour {{partnerName}},

Sauf erreur de notre part, la facture {{invoiceNumber}} émise par {{companyName}} reste impayée à ce jour.

  Échéance    : {{dueOn}} ({{daysOverdue}} jour(s) de retard)
  Reste dû    : {{amount}}

Il s'agit peut-être d'un simple oubli. Nous vous remercions de procéder au règlement, ou de nous indiquer la date à laquelle il interviendra.

Si le règlement a été effectué entre-temps, ce message peut se croiser avec lui ; dans ce cas, n'en tenez pas compte.`,
  2: `Bonjour {{partnerName}},

Malgré notre précédent rappel, la facture {{invoiceNumber}} émise par {{companyName}} demeure impayée.

  Échéance    : {{dueOn}} ({{daysOverdue}} jour(s) de retard)
  Reste dû    : {{amount}}

Nous vous demandons de procéder au règlement sous huitaine. Si le paiement se heurte à une difficulté, contactez-nous : un échéancier est préférable à un impayé.`,
  3: `Bonjour {{partnerName}},

La facture {{invoiceNumber}} émise par {{companyName}} reste impayée malgré nos relances.

  Échéance    : {{dueOn}} ({{daysOverdue}} jour(s) de retard)
  Reste dû    : {{amount}}

Par la présente, nous vous mettons en demeure d'en régler le montant sous quinze jours. À défaut, le recouvrement sera engagé et des pénalités de retard seront appliquées conformément aux conditions de la facture.

Si vous contestez tout ou partie de cette somme, faites-le nous savoir par écrit dans le même délai.`,
};

/** Niveau ramené aux trois textes disponibles (4 et 5 reprennent la mise en demeure). */
export function dunningLevelText(level: number): 1 | 2 | 3 {
  if (level <= 1) return 1;
  if (level === 2) return 2;
  return 3;
}

export function dunningMail(v: DunningMailVars): RenderedMail {
  const tier = dunningLevelText(v.level);
  const vars = {
    ...v,
    dueOn: formatDateFr(v.dueDate),
    amount: formatAmountFr(v.outstanding, v.currency),
  };
  const body = fill(DUNNING_BODIES[tier]!, vars);
  return compose({
    subject: fill(DUNNING_SUBJECTS[tier]!, vars),
    body: v.message?.trim() ? `${body}\n\n${v.message.trim()}` : body,
    reason: fill("Vous recevez ce message parce que la facture {{invoiceNumber}} de {{companyName}} vous a été adressée et n'est pas soldée.", vars),
    legalFooter: v.legalFooter,
  });
}
