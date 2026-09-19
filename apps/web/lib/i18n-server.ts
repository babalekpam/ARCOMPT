import { cookies } from "next/headers";
import { COOKIES, config } from "./config";
import { createTranslator, isLocale, type Locale, type Translator } from "./i18n";

/** Langue courante : cookie `arcompt_locale`, sinon DEFAULT_LOCALE (fr). */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(COOKIES.locale)?.value;
  return isLocale(value) ? value : config.defaultLocale();
}

/** `t()` lié à la langue courante, pour les composants serveur. */
export async function getT(): Promise<{ locale: Locale; t: Translator }> {
  const locale = await getLocale();
  return { locale, t: createTranslator(locale) };
}
