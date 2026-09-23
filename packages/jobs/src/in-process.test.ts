// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { createQueueFromEnv, InProcessQueue } from "./index.js";

const noSleep = async () => {};

describe("InProcessQueue", () => {
  it("exécute immédiatement quand un gestionnaire existe et réessaie avec délai exponentiel", async () => {
    const sleeps: number[] = [];
    const q = new InProcessQueue({ sleep: async (ms) => void sleeps.push(ms) });
    const attempts: number[] = [];
    q.process("whatsapp.reply", async (_p, ctx) => {
      attempts.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error("transitoire");
    });
    await q.enqueue("whatsapp.reply", { to: "+225", text: "ok" }, { backoffMs: 100 });
    await q.drain();
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([100, 200]);
    expect(q.failed).toHaveLength(0);
  });

  it("enregistre l'échec définitif après le nombre de tentatives", async () => {
    const q = new InProcessQueue({ sleep: noSleep });
    let calls = 0;
    q.process("document.extract", async () => {
      calls++;
      throw new Error("toujours KO");
    });
    await q.enqueue("document.extract", { tenantId: "t", userId: "u", documentId: "d" }, { attempts: 2 });
    await q.close();
    expect(calls).toBe(2);
    expect(q.failed).toHaveLength(1);
    expect(q.failed[0]).toMatchObject({ name: "document.extract", attempt: 2 });
    expect(q.failed[0]?.error.message).toBe("toujours KO");
  });

  it("garde les tâches en attente jusqu'à l'enregistrement du gestionnaire et respecte jobId", async () => {
    const q = new InProcessQueue({ sleep: noSleep });
    const seen: string[] = [];
    await q.enqueue("render.pdf", { tenantId: "t", kind: "bilan", params: {} }, { jobId: "bilan-2025" });
    await q.enqueue("render.pdf", { tenantId: "t", kind: "bilan", params: {} }, { jobId: "bilan-2025" });
    q.process("render.pdf", async (p) => void seen.push(p.kind));
    await q.drain();
    expect(seen).toEqual(["bilan"]);
  });

  it("createQueueFromEnv retombe sur InProcessQueue sans REDIS_URL", () => {
    expect(createQueueFromEnv({})).toBeInstanceOf(InProcessQueue);
  });
});
