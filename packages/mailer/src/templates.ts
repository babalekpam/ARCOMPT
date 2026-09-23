// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { MailError } from "./mailer.js";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./locale.js";

/**
 * Modèles de messages, en français et en anglais, registre soutenu
 * (vouvoiement en français, « we » de cabinet en anglais).
 *
 * Quatre règles tenues par tous les modèles :
 *  1. le corps en texte brut est la version de référence ; le HTML en est
 *     dérivé mécaniquement (`htmlFromText`) et ne porte rien de plus, donc un
 *     client qui n'affiche que le texte ne perd aucune information ;
 *  2. chaque message dit POURQUOI son destinataire le reçoit — un client d'une
 *     PME qui reçoit une demande de pièce n'a jamais entendu parler d'ARCOMPT ;
 *  3. chaque message se termine par les mentions légales de l'expéditeur
 *     (`MAIL_LEGAL_FOOTER`), qui ne sont pas connues du code ;
 *  4. **la langue est celle du destinataire**, jamais celle de l'expéditeur.
 *     Elle arrive résolue dans `locale` (voir `locale.ts`) ; en son absence,
 *     le français.
 *
 * L'anglais n'est pas une traduction mot à mot du français : c'est le même
 * message réécrit dans les tournures qu'emploie un cabinet anglophone. « Sauf
 * erreur de notre part » devient « Unless we are mistaken », « mise en
 * demeure » devient « formal notice » (le terme des Actes uniformes OHADA en
 * version anglaise), « sous huitaine » devient « within eight days ».
 *
 * Ton : celui d'un cabinet, pas d'une campagne. Pas d'emoji, pas de
 * superlatif, pas d'injonction. Une relance de niveau 3 reste polie.
 */

export { DEFAULT_LOCALE, LOCALES, isLocale, normalizeLocale, resolveLocale, type Locale, type LocaleSources } from "./locale.js";

/** Message rendu, prêt pour le `Mailer`. */
export interface RenderedMail {
  subject: string;
  text: string;
  /** Toujours produit à partir du texte : il s'y réduit sans perte. */
  html: string;
}

/** Toute variable de modèle accepte la langue du destinataire. */
export interface LocalizedMailVars {
  /**
   * Langue du DESTINATAIRE, déjà résolue par l'appelant avec `resolveLocale`.
   * Absente, le message part en français.
   */
  locale?: string | undefined;
}

/** Mentions légales à faire figurer en pied de message (raison sociale, adresse, RCCM, contact). */
export const LEGAL_FOOTER_ENV = "MAIL_LEGAL_FOOTER";

/**
 * Pied de page servi tant que `MAIL_LEGAL_FOOTER` n'est pas renseigné. Il est
 * volontairement explicite : un message parti avec ce texte se remarque à la
 * première lecture, au lieu de partir sans mentions du tout.
 *
 * Il reste en français dans les deux langues : c'est un défaut de
 * configuration adressé à l'exploitant, pas une phrase pour le destinataire.
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
 *
 * `lang` suit la langue du message : un lecteur d'écran et un correcteur
 * orthographique s'y fient, et un message anglais annoncé `lang="fr"` est lu
 * avec l'accent français.
 */
export function htmlFromText(text: string, locale: Locale = DEFAULT_LOCALE): string {
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
<html lang="${locale}"><head><meta charset="utf-8" /></head>
<body style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">
${paragraphs}
</body></html>`;
}

/** Les URL sont échappées AVANT d'arriver ici : on ne relit que du HTML sûr. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
}

/** Corps commun : le message, puis pourquoi il est reçu, puis les mentions légales. */
function compose(input: { subject: string; body: string; reason: string; legalFooter: string; locale: Locale }): RenderedMail {
  const text = `${input.body.trim()}\n\n--\n${input.reason.trim()}\n${input.legalFooter.trim()}\n`;
  return { subject: input.subject, text, html: htmlFromText(text, input.locale) };
}

/** Langue du destinataire, ou français. */
function localeOf(v: LocalizedMailVars): Locale {
  return normalizeLocale(v.locale) ?? DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------
// Date et montants
// ---------------------------------------------------------------------------

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Décimales d'affichage par devise. Reprise de `CURRENCY_DECIMALS`
 * (`@arcompt/ledger`) plutôt qu'importée, pour la même raison que
 * `locale.ts` : le mailer n'a aucune dépendance interne. Toute devise absente
 * de la table est traitée à deux décimales, comme partout ailleurs.
 *
 * Elle compte : un franc CFA n'a pas de centime, et une relance qui réclame
 * « 800,00 XOF » se lit comme une erreur de conversion.
 */
const CURRENCY_DECIMALS: Record<string, number> = { XOF: 0, XAF: 0, GNF: 0, KMF: 0, CDF: 2, EUR: 2, USD: 2 };

/** « 2025-06-01 » ou un horodatage ISO → « 01/06/2025 » (fr) ou « 1 Jun 2025 » (en). */
export function formatDate(value: string, locale: Locale = DEFAULT_LOCALE): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  if (locale === "en") {
    const month = EN_MONTHS[Number(mo) - 1];
    return month ? `${Number(d)} ${month} ${y}` : `${y}-${mo}-${d}`;
  }
  return `${d}/${mo}/${y}`;
}

/**
 * Horodatage ISO → « 01/06/2025 à 12:00 UTC » ou « 1 Jun 2025, 12:00 UTC ».
 * Le fuseau est dit, jamais supposé : ces messages traversent l'espace OHADA
 * et au-delà.
 */
export function formatDateTime(value: string, locale: Locale = DEFAULT_LOCALE): string {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return value;
  const iso = t.toISOString();
  const date = formatDate(iso, locale);
  const time = `${iso.slice(11, 16)} UTC`;
  return locale === "en" ? `${date}, ${time}` : `${date} à ${time}`;
}

/**
 * « 120000 » + « XOF » → « 120 000 XOF » (fr, espace insécable, code après)
 * ou « XOF 120,000 » (en, virgule, code avant). Le nombre de décimales vient
 * de la devise, pas de la langue.
 */
export function formatAmount(amount: string | number, currency: string, locale: Locale = DEFAULT_LOCALE): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const [whole = "0", cents = ""] = n.toFixed(decimals).split(".");
  const group = locale === "en" ? "," : "\u00a0";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const number = decimals > 0 ? `${grouped}${locale === "en" ? "." : ","}${cents}` : grouped;
  return locale === "en" ? `${currency}\u00a0${number}` : `${number}\u00a0${currency}`;
}

/** Mise en forme française, conservée pour les appels qui ne connaissent pas de langue. */
export function formatDateFr(value: string): string {
  return formatDate(value, "fr");
}

export function formatDateTimeFr(value: string): string {
  return formatDateTime(value, "fr");
}

export function formatAmountFr(amount: string | number, currency: string): string {
  return formatAmount(amount, currency, "fr");
}

// ---------------------------------------------------------------------------
// Invitation au portail
// ---------------------------------------------------------------------------

/**
 * Libellé de rôle tel qu'il se dit dans chaque langue. « dirigeant » se rend
 * par « owner » et non « director » : c'est le titulaire du dossier au sens de
 * la plateforme, celui à qui l'on notifie les accès, pas un mandataire social.
 */
export const MEMBER_ROLE_LABELS: Record<Locale, Record<string, string>> = {
  fr: {
    OWNER: "dirigeant",
    ACCOUNTANT: "comptable",
    CASHIER: "caissier",
    AUDITOR: "auditeur",
    REVIEWER: "réviseur",
  },
  en: {
    OWNER: "owner",
    ACCOUNTANT: "accountant",
    CASHIER: "cashier",
    AUDITOR: "auditor",
    REVIEWER: "reviewer",
  },
};

export interface InvitationMailVars extends LocalizedMailVars {
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

interface InvitationCopy {
  subject: string;
  body: string;
  reason: string;
  companyFiles: (n: number) => string;
}

const INVITATION: Record<Locale, InvitationCopy> = {
  fr: {
    subject: "Invitation à rejoindre {{organizationName}} sur ARCOMPT",
    body: `Bonjour,

{{organizationName}} vous invite à accéder à sa comptabilité sur ARCOMPT, avec le rôle de {{roleLabel}}, sur {{dossiers}}.

Pour accepter l'invitation, ouvrez le lien ci-dessous et connectez-vous : le code sera déjà rempli dans le formulaire « Accepter une invitation ».

{{acceptUrl}}

Si vous ouvrez ce lien depuis un autre appareil, recopiez ce code dans le formulaire.

Code d'invitation : {{token}}

Ce code est à usage unique et cesse d'être valable le {{expiresOn}}. Ne le transmettez à personne : il donne accès aux dossiers concernés.

Si vous n'attendiez pas cette invitation, ignorez ce message ; le code expirera sans avoir servi.`,
    reason: "Vous recevez ce message parce que {{organizationName}} a saisi votre adresse pour vous donner accès à sa comptabilité.",
    companyFiles: (n) => (n > 1 ? `${n} dossiers` : "1 dossier"),
  },
  en: {
    subject: "Invitation to join {{organizationName}} on ARCOMPT",
    body: `Hello,

{{organizationName}} is giving you access to its accounts on ARCOMPT, as {{roleLabel}}, for {{dossiers}}.

To accept, open the link below and sign in: the code will already be filled in on the "Accept an invitation" form.

{{acceptUrl}}

If you open this link on another device, type the code into the form yourself.

Invitation code: {{token}}

This code can be used once and stops working on {{expiresOn}}. Do not pass it on to anyone: it opens the company files it covers.

If you were not expecting this invitation, ignore this message; the code will expire unused.`,
    reason: "You are receiving this message because {{organizationName}} entered your address to give you access to its accounts.",
    companyFiles: (n) => (n > 1 ? `${n} company files` : "1 company file"),
  },
};

/**
 * Invitation : elle porte le lien ET le code à usage unique. Le lien transporte
 * le code dans son fragment, que le formulaire lit et préremplit sans que ce
 * code ne parte vers aucun serveur. Le code reste écrit en clair dans le
 * message, pour qui ouvre le lien sur un autre appareil ou préfère le recopier.
 */
export function invitationMail(v: InvitationMailVars): RenderedMail {
  const locale = localeOf(v);
  const copy = INVITATION[locale];
  const vars = {
    ...v,
    roleLabel: MEMBER_ROLE_LABELS[locale][v.role] ?? v.role,
    dossiers: copy.companyFiles(v.companyCount),
    expiresOn: formatDateTime(v.expiresAt, locale),
  };
  return compose({
    locale,
    subject: fill(copy.subject, vars),
    body: fill(copy.body, vars),
    reason: fill(copy.reason, vars),
    legalFooter: v.legalFooter,
  });
}

// ---------------------------------------------------------------------------
// Demande de pièce manquante
// ---------------------------------------------------------------------------

export interface MissingDocumentMailVars extends LocalizedMailVars {
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

interface MissingDocumentCopy {
  subject: string;
  body: string;
  reason: string;
  greeting: (name?: string) => string;
}

const MISSING_DOCUMENT: Record<Locale, MissingDocumentCopy> = {
  fr: {
    subject: "{{senderName}} : pièce manquante pour {{companyName}}",
    body: `{{greeting}}

{{senderName}} a besoin de la pièce suivante pour le dossier {{companyName}} :

{{description}}

Merci de la transmettre en réponse à ce message, de préférence au format PDF ou en photographie lisible.

Si vous l'avez déjà envoyée, ce message peut se croiser avec votre envoi ; dans ce cas, n'en tenez pas compte.`,
    reason: "Vous recevez ce message parce que {{senderName}} tient la comptabilité du dossier {{companyName}} et a besoin de cette pièce pour la justifier.",
    greeting: (name) => (name ? `Bonjour ${name},` : "Bonjour,"),
  },
  en: {
    subject: "{{senderName}}: document needed for {{companyName}}",
    body: `{{greeting}}

{{senderName}} needs the following document for {{companyName}}:

{{description}}

Please send it back in reply to this message, as a PDF or a clear photograph.

If you have already sent it, this message may have crossed with yours; in that case, please disregard it.`,
    reason: "You are receiving this message because {{senderName}} keeps the accounts of {{companyName}} and needs this document as supporting evidence.",
    greeting: (name) => (name ? `Hello ${name},` : "Hello,"),
  },
};

export function missingDocumentMail(v: MissingDocumentMailVars): RenderedMail {
  const locale = localeOf(v);
  const copy = MISSING_DOCUMENT[locale];
  const vars = { ...v, greeting: copy.greeting(v.partnerName) };
  return compose({
    locale,
    subject: fill(copy.subject, vars),
    body: fill(copy.body, vars),
    reason: fill(copy.reason, vars),
    legalFooter: v.legalFooter,
  });
}

// ---------------------------------------------------------------------------
// Accès d'un administrateur au dossier
// ---------------------------------------------------------------------------

export interface AdminAccessMailVars extends LocalizedMailVars {
  /** Dossier consulté. */
  companyName: string;
  /** Date et heure de l'accès (ISO). */
  accessedAt: string;
  /** Motif saisi par l'administrateur. */
  reason: string;
  legalFooter: string;
}

interface AccessCopy {
  subject: string;
  body: string;
  reason: string;
}

const ADMIN_ACCESS: Record<Locale, AccessCopy> = {
  fr: {
    subject: "Accès technique à votre dossier {{companyName}}",
    body: `Bonjour,

Nous vous informons qu'un technicien a accédé à votre dossier {{companyName}} le {{accessedOn}}.

Motif indiqué : {{reason}}

Cet accès est journalisé et consultable à tout moment dans votre portail, à la rubrique « Accès administrateur ». Il ne permet aucune modification de vos écritures validées, que la plateforme rend inaltérables.

Si cet accès vous paraît injustifié, répondez à ce message : nous vous en rendrons compte.`,
    reason: "Vous recevez ce message parce que vous êtes dirigeant du dossier {{companyName}} et que tout accès technique à un dossier vous est notifié.",
  },
  en: {
    subject: "Technical access to your company file {{companyName}}",
    body: `Hello,

We are writing to let you know that a technician accessed your company file {{companyName}} on {{accessedOn}}.

Reason given: {{reason}}

This access is logged and you can review it at any time in your portal, under "Administrator access". It cannot alter your validated entries, which the platform keeps immutable.

If this access looks unwarranted to you, reply to this message and we will account for it.`,
    reason: "You are receiving this message because you are the owner of {{companyName}} and every technical access to a company file is notified to you.",
  },
};

/** Notification d'un accès technique ordinaire, journalisé et consultable. */
export function adminAccessMail(v: AdminAccessMailVars): RenderedMail {
  const locale = localeOf(v);
  const copy = ADMIN_ACCESS[locale];
  const vars = { ...v, accessedOn: formatDateTime(v.accessedAt, locale) };
  return compose({
    locale,
    subject: fill(copy.subject, vars),
    body: fill(copy.body, vars),
    reason: fill(copy.reason, vars),
    legalFooter: v.legalFooter,
  });
}

export interface BreakGlassMailVars extends AdminAccessMailVars {
  /** Fin de validité de l'accès d'urgence (ISO). */
  expiresAt: string;
}

const BREAK_GLASS: Record<Locale, AccessCopy> = {
  fr: {
    subject: "Accès d'urgence à votre dossier {{companyName}}",
    body: `Bonjour,

Nous vous informons qu'un technicien a accédé à votre dossier {{companyName}} le {{accessedOn}} au titre d'un accès d'urgence.

Motif indiqué : {{reason}}

Un accès d'urgence est demandé par un administrateur, approuvé par un second, limité dans le temps et intégralement audité. Celui-ci prend fin le {{expiresOn}}.

Le détail figure dans votre portail, aux rubriques « Accès administrateur » et « Accès d'urgence ». Si cet accès vous paraît injustifié, répondez à ce message sans attendre.`,
    reason: "Vous recevez ce message parce que vous êtes dirigeant du dossier {{companyName}} et que tout accès d'urgence vous est notifié.",
  },
  en: {
    subject: "Emergency access to your company file {{companyName}}",
    body: `Hello,

We are writing to let you know that a technician accessed your company file {{companyName}} on {{accessedOn}} under emergency access.

Reason given: {{reason}}

Emergency access is requested by one administrator, approved by a second, limited in time and audited in full. This one ends on {{expiresOn}}.

The details are in your portal, under "Administrator access" and "Emergency access". If this access looks unwarranted to you, reply to this message without delay.`,
    reason: "You are receiving this message because you are the owner of {{companyName}} and every emergency access is notified to you.",
  },
};

/**
 * Notification d'un accès d'urgence (break-glass) : même fait, gravité
 * différente. Le message dit qu'un second administrateur a approuvé et quand
 * l'accès prend fin, parce que c'est ce qui permet au dirigeant de contrôler.
 */
export function breakGlassMail(v: BreakGlassMailVars): RenderedMail {
  const locale = localeOf(v);
  const copy = BREAK_GLASS[locale];
  const vars = { ...v, accessedOn: formatDateTime(v.accessedAt, locale), expiresOn: formatDateTime(v.expiresAt, locale) };
  return compose({
    locale,
    subject: fill(copy.subject, vars),
    body: fill(copy.body, vars),
    reason: fill(copy.reason, vars),
    legalFooter: v.legalFooter,
  });
}

// ---------------------------------------------------------------------------
// Relances de règlement
// ---------------------------------------------------------------------------

export interface DunningMailVars extends LocalizedMailVars {
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

/**
 * Les trois niveaux, dans les deux langues.
 *
 * « Mise en demeure » est rendu par « formal notice » : c'est le terme de la
 * version anglaise des Actes uniformes OHADA, et celui qu'attend un juriste
 * anglophone de la zone. « Late-payment interest » plutôt que « penalties »,
 * pour la même raison.
 *
 * Le bloc échéance / reste dû est aligné à la main dans chaque langue : les
 * étiquettes n'ont pas la même longueur en français et en anglais, et un
 * alignement traduit tel quel se décale.
 */
const DUNNING: Record<Locale, Record<1 | 2 | 3, { subject: string; body: string }> & { reason: string }> = {
  fr: {
    reason: "Vous recevez ce message parce que la facture {{invoiceNumber}} de {{companyName}} vous a été adressée et n'est pas soldée.",
    1: {
      subject: "Rappel : facture {{invoiceNumber}} échue",
      body: `Bonjour {{partnerName}},

Sauf erreur de notre part, la facture {{invoiceNumber}} émise par {{companyName}} reste impayée à ce jour.

  Échéance    : {{dueOn}} ({{daysOverdue}} jour(s) de retard)
  Reste dû    : {{amount}}

Il s'agit peut-être d'un simple oubli. Nous vous remercions de procéder au règlement, ou de nous indiquer la date à laquelle il interviendra.

Si le règlement a été effectué entre-temps, ce message peut se croiser avec lui ; dans ce cas, n'en tenez pas compte.`,
    },
    2: {
      subject: "Relance : facture {{invoiceNumber}} toujours impayée",
      body: `Bonjour {{partnerName}},

Malgré notre précédent rappel, la facture {{invoiceNumber}} émise par {{companyName}} demeure impayée.

  Échéance    : {{dueOn}} ({{daysOverdue}} jour(s) de retard)
  Reste dû    : {{amount}}

Nous vous demandons de procéder au règlement sous huitaine. Si le paiement se heurte à une difficulté, contactez-nous : un échéancier est préférable à un impayé.`,
    },
    3: {
      subject: "Mise en demeure : facture {{invoiceNumber}}",
      body: `Bonjour {{partnerName}},

La facture {{invoiceNumber}} émise par {{companyName}} reste impayée malgré nos relances.

  Échéance    : {{dueOn}} ({{daysOverdue}} jour(s) de retard)
  Reste dû    : {{amount}}

Par la présente, nous vous mettons en demeure d'en régler le montant sous quinze jours. À défaut, le recouvrement sera engagé et des pénalités de retard seront appliquées conformément aux conditions de la facture.

Si vous contestez tout ou partie de cette somme, faites-le nous savoir par écrit dans le même délai.`,
    },
  },
  en: {
    reason: "You are receiving this message because invoice {{invoiceNumber}} from {{companyName}} was issued to you and remains unsettled.",
    1: {
      subject: "Reminder: invoice {{invoiceNumber}} is past due",
      body: `Hello {{partnerName}},

Unless we are mistaken, invoice {{invoiceNumber}} issued by {{companyName}} is still unpaid.

  Due date    : {{dueOn}} ({{daysOverdue}} day(s) overdue)
  Amount due  : {{amount}}

This may simply have been overlooked. We would be grateful if you could settle it, or tell us when payment will be made.

If payment has been made in the meantime, this message may have crossed with it; in that case, please disregard it.`,
    },
    2: {
      subject: "Second reminder: invoice {{invoiceNumber}} still unpaid",
      body: `Hello {{partnerName}},

Despite our earlier reminder, invoice {{invoiceNumber}} issued by {{companyName}} remains unpaid.

  Due date    : {{dueOn}} ({{daysOverdue}} day(s) overdue)
  Amount due  : {{amount}}

We ask you to settle it within eight days. If payment presents a difficulty, please contact us: an instalment plan is better than an unpaid invoice.`,
    },
    3: {
      subject: "Formal notice: invoice {{invoiceNumber}}",
      body: `Hello {{partnerName}},

Invoice {{invoiceNumber}} issued by {{companyName}} remains unpaid despite our reminders.

  Due date    : {{dueOn}} ({{daysOverdue}} day(s) overdue)
  Amount due  : {{amount}}

By this letter we formally put you on notice to pay the amount within fifteen days. Failing that, recovery proceedings will be started and late-payment interest will be charged in accordance with the terms of the invoice.

If you dispute all or part of this amount, please tell us so in writing within the same period.`,
    },
  },
};

/** Niveau ramené aux trois textes disponibles (4 et 5 reprennent la mise en demeure). */
export function dunningLevelText(level: number): 1 | 2 | 3 {
  if (level <= 1) return 1;
  if (level === 2) return 2;
  return 3;
}

export function dunningMail(v: DunningMailVars): RenderedMail {
  const locale = localeOf(v);
  const tier = dunningLevelText(v.level);
  const copy = DUNNING[locale];
  const vars = {
    ...v,
    dueOn: formatDate(v.dueDate, locale),
    amount: formatAmount(v.outstanding, v.currency, locale),
  };
  const body = fill(copy[tier].body, vars);
  return compose({
    locale,
    subject: fill(copy[tier].subject, vars),
    body: v.message?.trim() ? `${body}\n\n${v.message.trim()}` : body,
    reason: fill(copy.reason, vars),
    legalFooter: v.legalFooter,
  });
}
