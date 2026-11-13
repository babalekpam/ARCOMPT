// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n-client";
import { Card, CardTitle } from "@/components/ui/Card";
import {
  attachInstallCapture,
  consumeInstallPrompt,
  detectInstallGuideKind,
  getDeferredInstallPrompt,
  isStandaloneDisplay,
  markInstallDone,
  readInstallState,
  subscribeInstallChanges,
  writeInstallState,
  type InstallGuideKind,
} from "@/lib/install-prompt";

/**
 * Entrée manuelle permanente, dans les réglages : l'invite du premier jour
 * peut être reportée ou manquée, l'installation doit rester retrouvable.
 * Même détenteur de l'invite native que la coque (lib/install-prompt.ts) :
 * si le navigateur la propose, le bouton la déclenche ; sinon, le mode
 * d'emploi du navigateur détecté s'affiche sur place.
 */
export function InstallAppCard() {
  const t = useT();
  const [, setTick] = useState(0);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    attachInstallCapture();
    if (isStandaloneDisplay()) writeInstallState(markInstallDone(readInstallState()));
    return subscribeInstallChanges(() => setTick((n) => n + 1));
  }, []);

  const installed = readInstallState().installed || isStandaloneDisplay();
  const deferred = !installed && getDeferredInstallPrompt() !== null;
  const guide: InstallGuideKind = detectInstallGuideKind(typeof navigator !== "undefined" ? navigator.userAgent : "");

  return (
    <Card>
      <CardTitle>{t("pwa.installCard.title")}</CardTitle>
      {installed ? (
        <p className="py-2 text-sm text-slate-600 dark:text-slate-300">✓ {t("pwa.installCard.installed")}</p>
      ) : (
        <>
          <p className="py-2 text-sm text-slate-600 dark:text-slate-300">{t("pwa.installCard.body")}</p>
          <div className="flex flex-wrap gap-2">
            {deferred ? (
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
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
                ⬇ {t("pwa.installCard.button")}
              </button>
            ) : (
              <button type="button" className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-600" onClick={() => setShowGuide((v) => !v)}>
                {t("pwa.installCard.showGuide")}
              </button>
            )}
          </div>
          {showGuide && !deferred ? (
            <>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{t("pwa.installPrompt.guideIntro")}</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
                <li>{t(`pwa.installPrompt.guide.${guide}.1`)}</li>
                <li>{t(`pwa.installPrompt.guide.${guide}.2`)}</li>
                <li>{t(`pwa.installPrompt.guide.${guide}.3`)}</li>
              </ol>
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}
