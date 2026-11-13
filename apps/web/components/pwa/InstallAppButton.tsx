// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n-client";
import {
  attachInstallCapture,
  consumeInstallPrompt,
  getDeferredInstallPrompt,
  isStandaloneDisplay,
  markInstallDone,
  readInstallState,
  subscribeInstallChanges,
  writeInstallState,
} from "@/lib/install-prompt";

/**
 * Entrée permanente « installer l'application » dans la coque.
 *
 * L'invite native est à usage unique et partagée : sa capture vit dans
 * `lib/install-prompt.ts`, qui la distribue entre ce bouton, la carte du
 * premier jour et l'entrée des réglages. Sans capture, l'utilisateur
 * dépendrait du menu du navigateur, que beaucoup ne trouvent pas.
 * Le bouton n'apparaît que lorsque le navigateur propose réellement
 * l'installation, et disparaît dès que l'application est installée.
 */
export function InstallAppButton() {
  const t = useT();
  const [, setTick] = useState(0);

  useEffect(() => {
    attachInstallCapture();
    if (isStandaloneDisplay()) writeInstallState(markInstallDone(readInstallState()));
    return subscribeInstallChanges(() => setTick((n) => n + 1));
  }, []);

  if (readInstallState().installed || isStandaloneDisplay() || !getDeferredInstallPrompt()) return null;
  return (
    <div className="border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        className="text-xs font-medium text-slate-700 underline decoration-slate-400 underline-offset-2 hover:text-slate-900 dark:text-slate-200 dark:hover:text-white"
        onClick={() => {
          void (async () => {
            const event = consumeInstallPrompt();
            if (!event) return;
            await event.prompt();
            const choice = await event.userChoice;
            if (choice.outcome === "accepted") writeInstallState(markInstallDone(readInstallState()));
          })();
        }}
      >
        ⬇ {t("pwa.install")}
      </button>
    </div>
  );
}
