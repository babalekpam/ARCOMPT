// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import {
  EMPTY_INSTALL_STATE,
  INSTALL_MAX_AUTO_SHOWS,
  INSTALL_SNOOZE_MS,
  detectInstallGuideKind,
  markInstallDone,
  markInstallShown,
  readInstallState,
  shouldAutoShowInstall,
  snoozeInstall,
  writeInstallState,
  type InstallPromptState,
} from "./install-prompt";
import { packCodeFromCountryCode } from "./offline-sync";

const NOW = 1_760_000_000_000;
const state = (over: Partial<InstallPromptState> = {}): InstallPromptState => ({ ...EMPTY_INSTALL_STATE, ...over });

describe("invite d'installation : ne pas harceler", () => {
  it("paraît la première fois", () => {
    expect(shouldAutoShowInstall(state(), NOW)).toBe(true);
  });

  it("ne paraît plus une fois l'application installée", () => {
    expect(shouldAutoShowInstall(state({ installed: true }), NOW)).toBe(false);
    expect(shouldAutoShowInstall(markInstallDone(state()), NOW)).toBe(false);
  });

  it("« Plus tard » la tait une semaine, puis elle peut revenir", () => {
    const snoozed = snoozeInstall(markInstallShown(state()), NOW);
    expect(snoozed.snoozedUntil).toBe(NOW + INSTALL_SNOOZE_MS);
    expect(shouldAutoShowInstall(snoozed, NOW + INSTALL_SNOOZE_MS - 1)).toBe(false);
    expect(shouldAutoShowInstall(snoozed, NOW + INSTALL_SNOOZE_MS)).toBe(true);
  });

  it("après le nombre maximal d'affichages, elle se tait pour de bon", () => {
    let s = state();
    let now = NOW;
    for (let i = 0; i < INSTALL_MAX_AUTO_SHOWS; i++) {
      expect(shouldAutoShowInstall(s, now)).toBe(true);
      s = snoozeInstall(markInstallShown(s), now);
      now += INSTALL_SNOOZE_MS; // le report expire, l'invite peut revenir…
    }
    // …sauf quand le compteur d'affichages est épuisé.
    expect(shouldAutoShowInstall(s, now)).toBe(false);
  });

  it("un affichage est compté une seule fois, même suivi d'un report", () => {
    const s = snoozeInstall(markInstallShown(state()), NOW);
    expect(s.shows).toBe(1);
  });

  it("l'état survit à un aller-retour dans le stockage, et un contenu abîmé retombe sur l'état vide", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    writeInstallState(state({ shows: 2, snoozedUntil: NOW + 1000 }), storage);
    expect(readInstallState(storage)).toEqual({ shows: 2, snoozedUntil: NOW + 1000, installed: false });
    mem.set("arcompt.installPrompt.v1", "{pas du json");
    expect(readInstallState(storage)).toEqual(EMPTY_INSTALL_STATE);
    expect(readInstallState(null)).toEqual(EMPTY_INSTALL_STATE);
  });
});

describe("mode d'emploi de repli selon le navigateur", () => {
  it("Chrome et Edge relèvent du parcours Chromium", () => {
    expect(detectInstallGuideKind("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36")).toBe("chromium");
    expect(detectInstallGuideKind("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0")).toBe("chromium");
  });

  it("Safari est reconnu malgré la mention Chrome absente", () => {
    expect(detectInstallGuideKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15")).toBe("safari");
    expect(detectInstallGuideKind("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("safari");
  });

  it("Firefox a son parcours propre, le reste tombe sur le générique", () => {
    expect(detectInstallGuideKind("Mozilla/5.0 (Windows NT 10.0; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe("firefox");
    expect(detectInstallGuideKind("UnNavigateur/1.0")).toBe("other");
  });
});

describe("code du pack depuis le profil du dossier", () => {
  it("le code pays du dossier donne le code du pack", () => {
    expect(packCodeFromCountryCode("TG")).toBe("tg");
    expect(packCodeFromCountryCode(" ci ")).toBe("ci");
    expect(packCodeFromCountryCode("tg")).toBe("tg");
  });

  it("une valeur absente ou malformée ne fabrique pas de code", () => {
    expect(packCodeFromCountryCode(null)).toBeNull();
    expect(packCodeFromCountryCode(undefined)).toBeNull();
    expect(packCodeFromCountryCode("")).toBeNull();
    expect(packCodeFromCountryCode("TGO")).toBeNull();
    expect(packCodeFromCountryCode("t1")).toBeNull();
  });
});
