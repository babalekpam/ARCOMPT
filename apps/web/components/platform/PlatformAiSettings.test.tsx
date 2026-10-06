import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformAiSettings } from "./PlatformAiSettings";
import { aiErrorState, emptyKeys, settingsDraft, type PlatformAiSettings as Settings } from "@/lib/platform-ai";

const mocks = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("@/hooks/use-platform-ai", () => ({ usePlatformAi: mocks.hook }));
vi.mock("@/lib/i18n-client", () => ({ useT: () => (key: string) => key }));
const settings: Settings = {
  revision: 11, defaultProvider: "anthropic", captureProvider: "openai", categorizeProvider: "gemini", encryptionAvailable: true,
  providers: [
    { id: "anthropic", name: "Anthropic", model: "claude-custom", source: "stored", configured: true },
    { id: "openai", name: "OpenAI", model: "gpt-custom", source: "environment", configured: true },
    { id: "gemini", name: "Gemini", model: "", source: "none", configured: false },
  ],
};
function state(extra: Record<string, unknown> = {}) {
  return {
    settings, draft: settingsDraft(settings), keys: emptyKeys(), loading: false, busy: false,
    blocked: false, dirty: false, error: null, notice: null, reload: vi.fn(), save: vi.fn(),
    test: vi.fn(), remove: vi.fn(), reset: vi.fn(), setKeys: vi.fn(), setDraft: vi.fn(), ...extra,
  };
}
beforeEach(() => mocks.hook.mockReturnValue(state()));
describe("platform AI forms and states", () => {
  it("renders separate password inputs, explicit models, configured sources and platform-wide warnings", () => {
    const html = renderToStaticMarkup(<PlatformAiSettings />);
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html.match(/autoComplete="off"/g) ?? html.match(/autocomplete="off"/g)).toHaveLength(4);
    expect(html).toContain('value="claude-custom"');
    expect(html).toContain('value="gpt-custom"');
    expect(html).toContain("stockage chiffré");
    expect(html).toContain("environnement");
    expect(html).toContain("potentiellement facturé");
    expect(html).toContain("Aucune donnée financière");
    expect(html).toContain("toutes les organisations");
  });
  it("shows a skeleton with no credential input until settings are loaded", () => {
    mocks.hook.mockReturnValue(state({ loading: true, settings: null, draft: null, blocked: true }));
    const html = renderToStaticMarkup(<PlatformAiSettings />);
    expect(html).toContain("Chargement de la configuration IA");
    expect(html).not.toContain('type="password"');
  });
  it("disables credentials and mutations when encryption is unavailable", () => {
    mocks.hook.mockReturnValue(state({ settings: { ...settings, encryptionAvailable: false }, blocked: true }));
    const html = renderToStaticMarkup(<PlatformAiSettings />);
    expect(html).toContain('fieldset disabled=""');
    expect(html).toContain("lecture seule");
    expect(html).toContain("chiffrement");
  });
  it("offers a security link when the verified admin access expires", () => {
    mocks.hook.mockReturnValue(state({ error: { kind: "auth", message: "Accès expiré." }, blocked: true }));
    const html = renderToStaticMarkup(<PlatformAiSettings />);
    expect(html).toContain('href="/account/security"');
    expect(html).toContain('fieldset disabled=""');
  });
  it("blocks stale saves and offers an explicit reload on conflicts", () => {
    mocks.hook.mockReturnValue(state({ error: { kind: "conflict", message: "Configuration modifiée." }, blocked: true }));
    const html = renderToStaticMarkup(<PlatformAiSettings />);
    expect(html).toContain("Recharger la version actuelle");
    expect(html).toContain('fieldset disabled=""');
  });
  it("shows real unavailable and failed-test feedback, never a success notice", () => {
    mocks.hook.mockReturnValue(state({ error: aiErrorState(new Error("offline")), notice: { ok: false, message: "Modèle refusé." } }));
    const html = renderToStaticMarkup(<PlatformAiSettings />);
    expect(html).toContain("Modèle refusé.");
    expect(html).toContain("Aucun succès n’est confirmé");
    expect(html).not.toContain("Configuration enregistrée");
  });
});
