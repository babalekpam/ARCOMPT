// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n-client";
import { getOfflineServices } from "@/lib/offline-browser";
import { refreshSnapshotsAuto } from "@/lib/offline-sync";
import {
  attachInstallCapture,
  consumeInstallPrompt,
  detectInstallGuideKind,
  getDeferredInstallPrompt,
  isStandaloneDisplay,
  markInstallDone,
  markInstallShown,
  readInstallState,
  shouldAutoShowInstall,
  snoozeInstall,
  subscribeInstallChanges,
  writeInstallState,
  type InstallGuideKind,
} from "@/lib/install-prompt";

/**
 * L'invite d'installation du « premier jour » (docs/OFFLINE.md).
 *
 * Elle paraît une fois, à la première arrivée sur le tableau de bord d'un
 * dossier configuré (coque montée avec un dossier actif) : c'est le moment
 * où le compte vient d'être activé et la configuration terminée. Ni à
 * chaque connexion, ni avant que le dossier existe. « Plus tard » la tait
 * une semaine, au plus trois affichages automatiques en tout ; l'entrée
 * manuelle des réglages reste toujours là.
 *
 * Sans invite native (Safari, Firefox), la même carte donne le mode
 * d'emploi en trois pas numérotés, adaptés au navigateur détecté.
 */
export function InstallPromptGate({ enabled }: { enabled: boolean }) {
  const t = useT();
  const pathname = usePathname();
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [ready, setReady] = useState(false);
  const decidedFor = useRef<string | null>(null);

  // Capture au plus tôt + réactions aux changements (invite arrivée, installation faite).
  useEffect(() => {
    attachInstallCapture();
    if (isStandaloneDisplay()) writeInstallState(markInstallDone(readInstallState()));
    return subscribeInstallChanges(() => {
      if (readInstallState().installed) {
        setOpen(false);
        setConfirmed(true);
      }
      setTick((n) => n + 1);
    });
  }, []);

  // La confirmation est un mot de bienvenue, pas un panneau permanent.
  useEffect(() => {
    if (!confirmed) return;
    const id = setTimeout(() => setConfirmed(false), 8000);
    return () => clearTimeout(id);
  }, [confirmed]);

  // Décision d'affichage : première arrivée sur le tableau de bord, dossier actif.
  useEffect(() => {
    if (!enabled || pathname !== "/dashboard" || open) return;
    if (decidedFor.current === pathname) return;
    decidedFor.current = pathname;
    if (isStandaloneDisplay()) return;
    const state = readInstallState();
    if (!shouldAutoShowInstall(state, Date.now())) return;
    const id = setTimeout(() => {
      writeInstallState(markInstallShown(readInstallState()));
      setOpen(true);
    }, 1500); // laisser le tableau de bord se poser : l'invite n'est pas une alerte
    return () => clearTimeout(id);
  }, [enabled, pathname, open]);

  // Au moment où la carte paraît : réchauffer le cliché de référence et dire
  // seulement la vérité sur sa présence (« données prêtes » si elles y sont).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      if (navigator.onLine) await refreshSnapshotsAuto().catch(() => undefined);
      const svc = await getOfflineServices();
      if (!svc || cancelled) return;
      const ages = await svc.snapshots.ages().catch(() => []);
      if (!cancelled) setReady(ages.length > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [open ]);

  const later = useCallback(() => {
    writeInstallState(snoozeInstall(readInstallState(), Date.now()));
    setOpen(false);
  }, []);

  const install = useCallback(async () => {
    const event = consumeInstallPrompt();
    if (!event) return;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === "accepted") {
        writeInstallState(markInstallDone(readInstallState()));
        setOpen(false);
        setConfirmed(true);
      } else {
        later(); // refus dans l'invite native = « plus tard », pas un échec à afficher
      }
    } catch {
      later();
    }
  }, [later]);

  if (confirmed) {
    return (
      <div className="fixed bottom-20 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl md:bottom-6 dark:bg-slate-100 dark:text-slate-900" role="status">
        ✓ {t("pwa.installPrompt.done")}
      </div>
    );
  }
  if (!open) return null;

  const deferred = getDeferredInstallPrompt();
  const guide: InstallGuideKind = detectInstallGuideKind(navigator.userAgent);

  return (
    <div className="fixed bottom-20 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl md:bottom-6 dark:border-slate-700 dark:bg-slate-900" role="dialog" aria-modal="false" aria-label={t("pwa.installPrompt.title")}>
      <h2 className="text-base font-semibold">{t("pwa.installPrompt.title")}</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t("pwa.installPrompt.body")}</p>
      {ready ? <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">✓ {t("pwa.installPrompt.ready")}</p> : null}
      {deferred ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => void install()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white">
            ⬇ {t("pwa.installPrompt.install")}
          </button>
          <button type="button" onClick={later} className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-600">
            {t("pwa.installPrompt.later")}
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{t("pwa.installPrompt.guideIntro")}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
            <li>{t(`pwa.installPrompt.guide.${guide}.1`)}</li>
            <li>{t(`pwa.installPrompt.guide.${guide}.2`)}</li>
            <li>{t(`pwa.installPrompt.guide.${guide}.3`)}</li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={later} className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-600">
              {t("pwa.installPrompt.later")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
