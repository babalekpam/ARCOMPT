"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useI18n } from "@/lib/i18n-client";
import { LOCALES, type Locale } from "@/lib/i18n";

/** Bascule FR / EN : écrit le cookie via /api/session/locale puis rafraîchit. */
export function LocaleSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const change = (next: Locale) => {
    if (next === locale) return;
    start(async () => {
      await fetch("/api/session/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: next }) });
      router.refresh();
    });
  };
  return (
    <div role="group" aria-label={t("locale.label")} className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-xs dark:border-slate-700">
      {LOCALES.map((l) => (
        <button key={l} type="button" disabled={pending} onClick={() => change(l)} aria-pressed={l === locale} className={`px-2 py-1 uppercase ${l === locale ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300"}`}>
          {compact ? l : t(`locale.${l}`)}
        </button>
      ))}
    </div>
  );
}
