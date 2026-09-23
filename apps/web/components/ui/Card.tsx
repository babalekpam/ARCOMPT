// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ReactNode } from "react";

export function Card({ children, className = "", as: Tag = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <Tag className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}>{children}</Tag>;
}

export function CardTitle({ children, hint, action }: { children: ReactNode; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{children}</h2>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}
