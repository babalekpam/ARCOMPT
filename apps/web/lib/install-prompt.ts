// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
/**
 * Installation de l'application sur l'appareil (docs/OFFLINE.md).
 *
 * Le propriétaire l'a dit simplement : les utilisateurs ne sont pas
 * techniciens, ils ne chercheront jamais le bouton d'installation dans les
 * menus du navigateur. L'application doit donc le leur proposer elle-même,
 * au bon moment — juste après la création du compte et la configuration du
 * premier dossier — et une seule fois de manière insistante.
 *
 * Ce module porte trois choses, séparées pour être testables :
 *
 *   1. la capture de l'événement `beforeinstallprompt` : Chrome/Edge ne le
 *      délivrent qu'une fois, tôt ; sans capture immédiate il est perdu et
 *      aucun bouton ne peut plus l'invoquer ;
 *   2. la machine à états « ne pas harceler » : un affichage automatique au
 *      plus {@link INSTALL_MAX_AUTO_SHOWS} fois, un report de
 *      {@link INSTALL_SNOOZE_MS} après « Plus tard », et plus jamais rien
 *      une fois l'application installée ;
 *   3. le mode d'emploi de repli pour les navigateurs sans invite
 *      (Safari, Firefox) : quelques pas numérotés, jamais une impasse.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Clé de l'état « ne pas harceler », conservé sur l'appareil. */
export const INSTALL_STATE_KEY = "arcompt.installPrompt.v1";
/** Au-delà, l'invite automatique se tait ; l'entrée manuelle (Réglages) reste. */
export const INSTALL_MAX_AUTO_SHOWS = 3;
/** Durée du report après « Plus tard » : une semaine. */
export const INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export interface InstallPromptState {
  /** Nombre d'affichages automatiques déjà faits. */
  shows: number;
  /** Instant (epoch ms) avant lequel l'invite automatique reste cachée. */
  snoozedUntil: number | null;
  /** L'application est installée : l'invite ne doit plus jamais paraître. */
  installed: boolean;
}

export const EMPTY_INSTALL_STATE: InstallPromptState = { shows: 0, snoozedUntil: null, installed: false };

/** L'invite automatique peut-elle paraître ? Fonction pure : c'est elle que les tests exercent. */
export function shouldAutoShowInstall(state: InstallPromptState, now: number): boolean {
  if (state.installed) return false;
  if (state.shows >= INSTALL_MAX_AUTO_SHOWS) return false;
  if (state.snoozedUntil !== null && now < state.snoozedUntil) return false;
  return true;
}

/** Comptabilise un affichage automatique. */
export function markInstallShown(state: InstallPromptState): InstallPromptState {
  return { ...state, shows: state.shows + 1 };
}

/**
 * « Plus tard » : on se tait une semaine. L'affichage a déjà été compté par
 * {@link markInstallShown} à l'ouverture — on ne compte pas deux fois le
 * même passage.
 */
export function snoozeInstall(state: InstallPromptState, now: number): InstallPromptState {
  return { ...state, snoozedUntil: now + INSTALL_SNOOZE_MS };
}

/** Installation faite (ou application déjà en mode installé) : silence définitif. */
export function markInstallDone(state: InstallPromptState): InstallPromptState {
  return { ...state, installed: true, snoozedUntil: null };
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readInstallState(storage: StorageLike | null = defaultStorage()): InstallPromptState {
  if (!storage) return { ...EMPTY_INSTALL_STATE };
  try {
    const raw = storage.getItem(INSTALL_STATE_KEY);
    if (!raw) return { ...EMPTY_INSTALL_STATE };
    const parsed = JSON.parse(raw) as Partial<InstallPromptState>;
    return {
      shows: typeof parsed.shows === "number" && parsed.shows >= 0 ? parsed.shows : 0,
      snoozedUntil: typeof parsed.snoozedUntil === "number" ? parsed.snoozedUntil : null,
      installed: parsed.installed === true,
    };
  } catch {
    return { ...EMPTY_INSTALL_STATE };
  }
}

export function writeInstallState(state: InstallPromptState, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(INSTALL_STATE_KEY, JSON.stringify(state));
  } catch {
    /* stockage plein ou bloqué : l'état est un confort, pas une barrière */
  }
}

/** L'application tourne-t-elle déjà installée (fenêtre autonome) ? */
export function isStandaloneDisplay(win: Window | undefined = typeof window !== "undefined" ? window : undefined): boolean {
  if (!win) return false;
  try {
    if (win.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (win.matchMedia?.("(display-mode: fullscreen)").matches) return true;
    if ((win.navigator as Navigator & { standalone?: boolean }).standalone === true) return true; // iOS Safari
    if (win.document?.referrer?.startsWith("android-app://")) return true;
  } catch {
    /* un matchMedia capricieux ne doit pas empêcher le reste */
  }
  return false;
}

export type InstallGuideKind = "chromium" | "safari" | "firefox" | "other";

/**
 * Quel mode d'emploi montrer quand le navigateur ne fournit pas d'invite.
 * Fonction pure sur l'agent utilisateur : c'est elle que les tests exercent.
 */
export function detectInstallGuideKind(userAgent: string): InstallGuideKind {
  const ua = userAgent.toLowerCase();
  if (/edg\//.test(ua) || /chrome\//.test(ua) || /chromium\//.test(ua) || /opr\//.test(ua)) return "chromium";
  if (/firefox\//.test(ua) || /fxios\//.test(ua)) return "firefox";
  if (/safari\//.test(ua)) return "safari";
  return "other";
}

/* ------------------------------------------------------------------ */
/* Capture de l'invite native : un seul détenteur pour toute la coque. */
/* ------------------------------------------------------------------ */

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let captureAttached = false;
const subscribers = new Set<() => void>();

function notifyInstallSubscribers(): void {
  for (const cb of [...subscribers]) {
    try {
      cb();
    } catch {
      /* un abonné fautif ne doit pas casser les autres */
    }
  }
}

/** À appeler au plus tôt dans la coque : l'événement ne repasse pas. Idempotent. */
export function attachInstallCapture(): void {
  if (captureAttached || typeof window === "undefined") return;
  captureAttached = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // sans cela, Chrome affiche sa mini-barre une fois puis se tait
    deferredPrompt = e as BeforeInstallPromptEvent;
    notifyInstallSubscribers();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    writeInstallState(markInstallDone(readInstallState()));
    notifyInstallSubscribers();
  });
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

/**
 * Consomme l'invite capturée : elle est à usage unique côté navigateur.
 * L'appelant enchaîne sur `event.prompt()` immédiatement.
 */
export function consumeInstallPrompt(): BeforeInstallPromptEvent | null {
  const event = deferredPrompt;
  deferredPrompt = null;
  if (event) notifyInstallSubscribers();
  return event;
}

export function subscribeInstallChanges(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
