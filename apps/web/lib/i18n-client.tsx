"use client";
/**
 * Fournit la langue et `t()` aux îlots clients. Le dictionnaire complet est
 * injecté par le layout racine (quelques Ko) pour éviter un aller-retour.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, createTranslator, interpolate, type Locale, type Messages, type Params, type Translator } from "./i18n";

interface I18nContextValue {
  locale: Locale;
  messages: Messages;
  t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(() => {
    const t: Translator = (key, params?: Params) => interpolate(messages[key] ?? createTranslator("fr")(key), params);
    return { locale, messages, t };
  }, [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n doit être utilisé sous <I18nProvider>");
  return ctx;
}

export function useT(): Translator {
  return useI18n().t;
}

/**
 * Langue courante, tolérante à l'absence de fournisseur.
 *
 * `useI18n` lève hors du fournisseur, ce qui est juste pour `t()` : un écran
 * sans dictionnaire est un bug. Mais un îlot de mise en forme — un montant, une
 * date — doit pouvoir se rendre dans un arbre de test ou une prévisualisation
 * sans faire tomber la page ; il retombe alors sur la langue par défaut.
 */
export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? DEFAULT_LOCALE;
}
