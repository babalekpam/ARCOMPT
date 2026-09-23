"use client";
import { useLocale } from "@/lib/i18n-client";
import { formatAmount, isNegative } from "@/lib/money";

/**
 * Affiche un montant (chaîne canonique de l'API) avec les séparateurs de la
 * langue courante et les décimales de la devise. Jamais de flottant : le
 * formatage se fait sur la chaîne.
 *
 * L'îlot lit la langue lui-même plutôt que de la recevoir en propriété : c'est
 * ce qui garantit qu'aucun des points d'appel ne peut l'oublier et laisser un
 * « 1 234,50 » dans une interface anglaise.
 */
export function Money({
  value,
  currency = "XOF",
  dashForZero = false,
  showCurrency = false,
  colorSign = false,
  className = "",
}: {
  value: string | null | undefined;
  currency?: string;
  dashForZero?: boolean;
  showCurrency?: boolean;
  colorSign?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  const text = formatAmount(value, currency, { dashForZero, locale });
  const neg = value ? isNegative(value) : false;
  // Le code ISO précède le montant en anglais (« XOF 1,234 ») et le suit en
  // français (« 1 234 XOF ») : c'est l'usage des affaires dans chaque langue.
  const code = showCurrency && text && text !== "—" ? <span className={locale === "en" ? "mr-1 text-xs text-slate-500" : "ml-1 text-xs text-slate-500"}>{currency}</span> : null;
  return (
    <span className={`tabular-nums whitespace-nowrap ${colorSign && neg ? "text-red-600 dark:text-red-400" : ""} ${className}`}>
      {locale === "en" ? code : null}
      {text}
      {locale === "en" ? null : code}
    </span>
  );
}
