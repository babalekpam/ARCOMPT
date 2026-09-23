import { Hono } from "hono";
import type { PlatformCompany } from "../identity.js";
import type { AuthContext } from "../auth.js";

export function platformRoutes(resolveCompanies?: (sub: string) => Promise<PlatformCompany[]>) {
  const r = new Hono();
  r.use("*", async (c, next) => {
    const auth = c.get("auth") as AuthContext;
    if (!auth.platformAdmin) return c.json({ error: { code: "FORBIDDEN", message: "Administration plateforme requise" } }, 403);
    return next();
  });
  r.get("/me", (c) => c.json({ platformAdmin: true }));
  r.get("/companies", async (c) => {
    const auth = c.get("auth") as AuthContext;
    // The subject is deliberately kept out of AuthContext; the callback is
    // supplied by app.ts with the verified Clerk subject captured per request.
    const list = resolveCompanies;
    if (!list || !auth.platformSub) return c.json({ error: { code: "UNAVAILABLE", message: "Découverte plateforme indisponible" } }, 503);
    const companies = await list(auth.platformSub);
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