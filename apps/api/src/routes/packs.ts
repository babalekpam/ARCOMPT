import { Hono } from "hono";
import { listPackCodes, loadPack, PackError } from "@arcompt/country-packs";

export function packsRoutes() {
  const r = new Hono();
  r.get("/", (c) => c.json({ packs: listPackCodes().map((code) => { const p = loadPack(code); return { code, name: p.name, version: p.version, status: p.status, currency: p.identity.currency }; }) }));
  r.get("/:code", (c) => {
    try {
      return c.json(loadPack(c.req.param("code")));
    } catch (e) {
      if (e instanceof PackError) return c.json({ error: { code: "PACK_INVALID", message: e.message } }, 422);
      return c.json({ error: { code: "NOT_FOUND", message: "Pack inconnu" } }, 404);
    }
  });
  return r;
}
