"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, apiClient } from "@/lib/api-client";

/** The selected company's unresolved reminders, not the first page of failed jobs. */
export function ReminderReviewAlert({ tenantId }: { tenantId: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    setCount(null);
    setUnavailable(false);
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const result = await apiClient<{ count: number }>("/jobs/review-count", { cache: "no-store" });
        if (active) {
          setCount(result.count);
          setUnavailable(false);
        }
      } catch (error) {
        if (active) {
          // Never display a stale count. Restricted roles do not see this alert.
          setCount(null);
          setUnavailable(!(error instanceof ApiError && error.isAuth));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("reminder-review-changed", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("reminder-review-changed", onVisible);
    };
  }, [tenantId]);

  if (unavailable) return (
    <Link href="/operations/jobs" className="block border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100" role="status">
      Vérification des rappels indisponible · Ouvrir les opérations
    </Link>
  );
  if (count === null || count === 0) return null;
  return (
    <Link href="/operations/jobs" className="block border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-950 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100 dark:hover:bg-amber-950" role="status">
      {count} rappel{count > 1 ? "s" : ""} en échec à vérifier · Ouvrir les opérations
    </Link>
  );
}