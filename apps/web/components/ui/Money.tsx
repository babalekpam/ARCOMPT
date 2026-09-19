import { formatAmount, isNegative } from "@/lib/money";

/**
 * Affiche un montant (chaîne canonique de l'API) avec séparateurs de milliers
 * et décimales de la devise. Jamais de flottant : formatage sur chaîne.
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
  const text = formatAmount(value, currency, { dashForZero });
  const neg = value ? isNegative(value) : false;
  return (
    <span className={`tabular-nums whitespace-nowrap ${colorSign && neg ? "text-red-600 dark:text-red-400" : ""} ${className}`}>
      {text}
      {showCurrency && text && text !== "—" ? <span className="ml-1 text-xs text-slate-500">{currency}</span> : null}
    </span>
  );
}
