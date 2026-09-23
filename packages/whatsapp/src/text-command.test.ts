// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { parseTextCommand } from "./text-command.js";
import { parseMetaWebhook, normalizePhone } from "./provider.js";
import { signMetaBody, verifyMetaSignature } from "./meta-cloud.js";

const now = () => new Date("2025-03-06T10:00:00Z");

describe("saisie texte WhatsApp", () => {
  it("comprend « j'ai payé 50 000 de carburant en espèces »", () => {
    expect(parseTextCommand("j'ai payé 50 000 de carburant en espèces", now)).toEqual({ kind: "EXPENSE", amount: "50000", label: "carburant", means: "CASH", date: null, confidence: 0.9 });
  });

  it("reconnaît les moyens de paiement, les abréviations et les dates", () => {
    expect(parseTextCommand("payé 25k loyer bureau par virement banque hier", now)).toMatchObject({ amount: "25000", label: "loyer bureau", means: "BANK", date: "2025-03-05" });
    expect(parseTextCommand("Dépensé 12.500 FCFA de crédit téléphone via orange money le 03/03", now)).toMatchObject({ amount: "12500", label: "crédit téléphone via", means: "MOBILE_MONEY", date: "2025-03-03" });
    expect(parseTextCommand("encaissé 100000 du client Alpha en espèces", now)?.kind).toBe("INCOME");
  });

  it("renvoie null sans montant ou sans libellé", () => {
    expect(parseTextCommand("bonjour", now)).toBeNull();
    expect(parseTextCommand("payé 5000", now)).toBeNull();
  });

  it("normalise les webhooks Meta et vérifie la signature", () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "2250707070707", profile: { name: "Awa" } }],
                messages: [
                  { id: "wamid.1", from: "2250707070707", timestamp: "1741255200", type: "text", text: { body: "salut" } },
                  { id: "wamid.2", from: "2250707070707", timestamp: "1741255201", type: "image", image: { id: "media-1", mime_type: "image/jpeg" } },
                  { id: "wamid.3", from: "2250707070707", timestamp: "1741255202", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "validate:abc", title: "VALIDER" } } },
                ],
              },
            },
          ],
        },
      ],
    };
    const msgs = parseMetaWebhook(body);
    expect(msgs.map((m) => m.type)).toEqual(["TEXT", "IMAGE", "INTERACTIVE"]);
    expect(msgs[0]).toMatchObject({ id: "wamid.1", from: "2250707070707", text: "salut", senderName: "Awa", timestamp: 1741255200 });
    expect(msgs[1]?.mediaId).toBe("media-1");
    expect(msgs[2]?.buttonId).toBe("validate:abc");
    expect(normalizePhone("+225 07 07 07 07 07")).toBe("2250707070707");
    const raw = JSON.stringify(body);
    expect(verifyMetaSignature(raw, signMetaBody(raw, "secret"), "secret")).toBe(true);
    expect(verifyMetaSignature(raw, signMetaBody(raw, "autre"), "secret")).toBe(false);
    expect(verifyMetaSignature(raw, undefined, "secret")).toBe(false);
  });
});
