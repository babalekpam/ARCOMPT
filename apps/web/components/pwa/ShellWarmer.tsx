// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Réchauffe la coquille hors ligne (docs/OFFLINE.md).
 *
 * Le service worker précache le HTML des écrans principaux à l'installation,
 * mais pas leurs morceaux de JavaScript : un écran jamais visité en ligne
 * s'ouvrirait hors ligne sur une coquille vide. En préchargeant les routes
 * de la coquille pendant que le réseau est là, leurs morceaux transitent par
 * le service worker et entrent dans son cache — l'écran s'ouvre alors pour
 * de vrai, sans réseau. La liste suit SHELL_ROUTES dans public/sw.js.
 */
const SHELL_ROUTES = ["/dashboard", "/entries", "/entries/new", "/balance", "/invoices", "/invoices/new", "/partners", "/documents", "/sync", "/statements"];

export function ShellWarmer() {
  const router = useRouter();
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    let done = false;
    const warm = () => {
      if (done || !navigator.onLine) return;
      done = true;
      for (const route of SHELL_ROUTES) {
        try {
          router.prefetch(route);
        } catch {
          /* un préchargement raté ne doit jamais gêner l'écran courant */
        }
      }
    };
    // Laisser l'écran courant se charger d'abord : le réchauffement est un
    // travail de fond, déclenché quand le navigateur est libre ou en ligne.
    const idle = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    if (idle.requestIdleCallback) idle.requestIdleCallback(warm, { timeout: 5_000 });
    else window.setTimeout(warm, 2_000);
    window.addEventListener("online", warm);
    return () => window.removeEventListener("online", warm);
  }, [router]);
  return null;
}
