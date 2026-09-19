/**
 * Internationalisation légère : un dictionnaire plat par langue, des clés
 * pointées ("nav.entries") et des paramètres {name}. Sans dépendance.
 *
 * Ce module ne touche ni aux cookies ni à React : il sert côté serveur et côté
 * client. La lecture du cookie de langue est dans `lib/i18n-server.ts`.
 */
import frBase from "../messages/fr.json";
import enBase from "../messages/en.json";
// Dictionnaires par module (écrans métier) : un fichier par module et par langue,
// fusionnés ici pour que plusieurs modules puissent être développés en parallèle
// sans se disputer un fichier unique.
import frInvoicing from "../messages/modules/invoicing.fr.json";
import enInvoicing from "../messages/modules/invoicing.en.json";
import frTreasury from "../messages/modules/treasury.fr.json";
import enTreasury from "../messages/modules/treasury.en.json";
import frPayroll from "../messages/modules/payroll.fr.json";
import enPayroll from "../messages/modules/payroll.en.json";
import frTax from "../messages/modules/tax.fr.json";
import enTax from "../messages/modules/tax.en.json";
import frAssets from "../messages/modules/assets.fr.json";
import enAssets from "../messages/modules/assets.en.json";
import frClosing from "../messages/modules/closing.fr.json";
import enClosing from "../messages/modules/closing.en.json";
import frDocuments from "../messages/modules/documents.fr.json";
import enDocuments from "../messages/modules/documents.en.json";
import frFirm from "../messages/modules/firm.fr.json";
import enFirm from "../messages/modules/firm.en.json";

const fr: Record<string, string> = { ...frBase, ...frInvoicing, ...frTreasury, ...frPayroll, ...frTax, ...frAssets, ...frClosing, ...frDocuments, ...frFirm };
const en: Record<string, string> = { ...enBase, ...enInvoicing, ...enTreasury, ...enPayroll, ...enTax, ...enAssets, ...enClosing, ...enDocuments, ...enFirm };

export type Locale = "fr" | "en";
export const LOCALES: Locale[] = ["fr", "en"];
export const DEFAULT_LOCALE: Locale = "fr";

export type Messages = Record<string, string>;
export type MessageKey = keyof typeof frBase;

const dictionaries: Record<Locale, Messages> = { fr, en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as string[]).includes(value);
}

export function getMessages(locale: Locale): Messages {
  return dictionaries[locale] ?? dictionaries.fr;
}

export type Params = Record<string, string | number | undefined>;

/** Remplace les {paramètres} d'un message ; les paramètres inconnus restent tels quels. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = params[key];
    return v === undefined ? match : String(v);
  });
}

/**
 * Traduit une clé. Repli sur le français puis sur la clé elle-même, pour
 * qu'une traduction manquante reste visible et ne casse jamais l'écran.
 */
export function translate(locale: Locale, key: string, params?: Params): string {
  const msg = dictionaries[locale]?.[key] ?? dictionaries.fr[key] ?? key;
  return interpolate(msg, params);
}

export type Translator = (key: MessageKey | (string & {}), params?: Params) => string;

/** Fabrique un `t()` lié à une langue. */
export function createTranslator(locale: Locale): Translator {
  return (key, params) => translate(locale, key, params);
}

/** Libellé d'une langue dans sa propre langue. */
export function localeLabel(locale: Locale): string {
  return translate(locale, `locale.${locale}`);
}

/** Vérifie que les deux dictionnaires ont les mêmes clés (utilisé par les tests). */
export function missingKeys(from: Locale, to: Locale): string[] {
  const src = Object.keys(dictionaries[from]);
  const dst = new Set(Object.keys(dictionaries[to]));
  return src.filter((k) => !dst.has(k));
}

/** Format de date court selon la langue, sans dépendance (dates ISO AAAA-MM-JJ). */
export function formatDate(locale: Locale, iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return locale === "en" ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}/${m[2]}/${m[1]}`;
}
