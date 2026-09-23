import { describe, expect, it } from "vitest";
import { ASSISTANT_FOOTER, hasFooter, normalizeQuestion, splitAnswer, SUGGESTED_QUESTION_KEYS } from "./helpers";

describe("assistant helpers", () => {
  it("détecte et sépare le pied de page obligatoire", () => {
    expect(hasFooter("Vos clients vous doivent 1 200 000.\n\nNe remplace pas l'expert-comptable.")).toBe(true);
    expect(hasFooter("Rien à signaler.")).toBe(false);
    const s = splitAnswer("Trésorerie : 500 000 XOF.\n\nNe remplace pas l’expert-comptable");
    expect(s.body).toBe("Trésorerie : 500 000 XOF.");
    expect(s.footer).toBe(ASSISTANT_FOOTER);
  });

  it("ajoute le pied de page quand il manque, sans vider la réponse", () => {
    const s = splitAnswer("Réponse courte");
    expect(s.body).toBe("Réponse courte");
    expect(s.footer).toBe(ASSISTANT_FOOTER);
    expect(splitAnswer("Ne remplace pas l'expert-comptable").body).toBe("Ne remplace pas l'expert-comptable");
  });

  it("normalise la question dans les limites de l'API", () => {
    expect(normalizeQuestion("  Qui   me doit ? ")).toBe("Qui me doit ?");
    expect(normalizeQuestion("a")).toBeNull();
    expect(normalizeQuestion("x".repeat(2001))).toBeNull();
    expect(SUGGESTED_QUESTION_KEYS).toHaveLength(3);
  });
});
