// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n-client";

/** Enregistre /sw.js et propose de recharger quand une nouvelle version est prête. */
export function ServiceWorkerRegistrar() {
  const t = useT();
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" && !window.location.search.includes("sw=1")) return; // en dev, le SW gêne le rechargement à chaud
    let cancelled = false;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          worker?.addEventListener("statechange", () => {
            if (!cancelled && worker.state === "installed" && navigator.serviceWorker.controller) setUpdateReady(true);
          });
        });
      })
      .catch((e) => console.warn("Service worker non enregistré :", e));
    return () => {
      cancelled = true;
    };
  }, []);
  if (!updateReady) return null;
  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs text-white shadow-lg md:bottom-4 dark:bg-slate-100 dark:text-slate-900">
      {t("pwa.updateAvailable")}{" "}
      <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>
        {t("pwa.reload")}
      </button>
    </div>
  );
}
