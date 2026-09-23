// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "danger" | "warning" | "info";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}>{children}</span>;
}

/** Badge de statut d'écriture : DRAFT / VALIDATED / QUEUED / REVERSED. */
export function StatusBadge({ status, label }: { status: "DRAFT" | "VALIDATED" | "QUEUED" | "PENDING" | "REVERSED"; label: string }) {
  const tone: BadgeTone = status === "VALIDATED" ? "success" : status === "QUEUED" ? "warning" : status === "REVERSED" ? "info" : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
}
