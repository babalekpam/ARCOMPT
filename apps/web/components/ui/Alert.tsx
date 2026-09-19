import type { ReactNode } from "react";

const tones = {
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
};

export function Alert({ tone = "info", children, className = "" }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]} ${className}`}>
      {children}
    </div>
  );
}
