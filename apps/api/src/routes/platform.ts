import { Hono } from "hono";
import type { PlatformCompany } from "../identity.js";
import type { AuthContext } from "../auth.js";
import type { AdminModeEvidence } from "../admin-mode.js";

export function platformRoutes(
  resolveCompanies?: (sub: string, mode?: AdminModeEvidence) => Promise<PlatformCompany[]>,
  resolveOverview?: (sub: string, mode?: AdminModeEvidence) => Promise<unknown>,
) {
  const r = new Hono();
  r.use("*", async (c, next) => {
    const auth = c.get("auth") as AuthContext;
    if (!auth.platformAdmin) return c.json({ error: { code: "FORBIDDEN", message: "Administration plateforme requise" } }, 403);
    return next();
  });
  r.get("/me", (c) => c.json({ platformAdmin: true }));
  r.get("/overview", async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = c.get("auth") as AuthContext;
    if (!resolveOverview || !auth.platformSub) return c.json({ error: { code: "UNAVAILABLE", message: "Vue plateforme indisponible" } }, 503);
    const data = await resolveOverview(auth.platformSub, auth.platformMode);
    return c.json(data as Record<string, unknown>);
  });
  r.get("/companies", async (c) => {
    const auth = c.get("auth") as AuthContext;
    // The subject is deliberately kept out of AuthContext; the callback is
    // supplied by app.ts with the verified Clerk subject captured per request.
    const list = resolveCompanies;
    if (!list || !auth.platformSub) return c.json({ error: { code: "UNAVAILABLE", message: "Découverte plateforme indisponible" } }, 503);
    const companies = await list(auth.platformSub, auth.platformMode);
    return c.json({ companies: companies.map((company) => ({
      id: company.companyId,
      name: company.companyName,
      organizationId: company.organizationId,
      organizationName: company.organizationName,
      countryCode: company.countryCode,
    })) });
  });
  return r;
}