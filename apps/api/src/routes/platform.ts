import { Hono } from "hono";
import type { PlatformCompany } from "../identity.js";
import type { AuthContext } from "../auth.js";
import type { AdminModeEvidence } from "../admin-mode.js";

export interface SetSubscriptionInput {
  planCode: string;
  startedAt?: string | null;
  endedAt?: string | null;
  pricePerDossier?: number | null;
}

export type SetSubscriptionFn = (
  sub: string,
  mode: AdminModeEvidence | undefined,
  organizationId: string,
  input: SetSubscriptionInput,
) => Promise<Record<string, unknown>>;

const PLAN_CODES = ["TRIAL", "ESSENTIEL", "PRO", "CABINET"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function platformRoutes(
  resolveCompanies?: (sub: string, mode?: AdminModeEvidence) => Promise<PlatformCompany[]>,
  resolveOverview?: (sub: string, mode?: AdminModeEvidence) => Promise<unknown>,
  setSubscription?: SetSubscriptionFn,
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
  // Changement d'offre manuel (opérateur plateforme) : la fonction SQL
  // security-definer revérifie le mode actif, écrit l'abonnement et journalise.
  r.put("/organizations/:id/subscription", async (c) => {
    const auth = c.get("auth") as AuthContext;
    if (!setSubscription || !auth.platformSub) return c.json({ error: { code: "UNAVAILABLE", message: "Changement d'offre indisponible" } }, 503);
    const body = (await c.req.json().catch(() => null)) as Partial<SetSubscriptionInput> | null;
    if (!body || typeof body.planCode !== "string" || !PLAN_CODES.includes(body.planCode)) {
      return c.json({ error: { code: "VALIDATION", message: "Offre inconnue" } }, 400);
    }
    const date = (v: unknown): string | null | undefined =>
      v === undefined ? undefined : v === null ? null : typeof v === "string" && ISO_DATE.test(v) ? v : undefined;
    const startedAt = date(body.startedAt);
    const endedAt = date(body.endedAt);
    if (startedAt === undefined && body.startedAt !== undefined || endedAt === undefined && body.endedAt !== undefined) {
      return c.json({ error: { code: "VALIDATION", message: "Dates au format AAAA-MM-JJ attendues" } }, 400);
    }
    if (body.pricePerDossier !== undefined && body.pricePerDossier !== null &&
        (typeof body.pricePerDossier !== "number" || !Number.isFinite(body.pricePerDossier) || body.pricePerDossier < 0)) {
      return c.json({ error: { code: "VALIDATION", message: "Prix par dossier invalide" } }, 400);
    }
    c.header("Cache-Control", "no-store");
    const result = await setSubscription(auth.platformSub, auth.platformMode, c.req.param("id"), {
      planCode: body.planCode,
      startedAt: startedAt ?? null,
      endedAt: endedAt ?? null,
      pricePerDossier: body.pricePerDossier ?? null,
    });
    if (result?.ok === true) return c.json(result);
    const code = String((result as { code?: unknown })?.code ?? "ERROR");
    const status = code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 400;
    return c.json({ error: { code, message: String((result as { message?: unknown })?.message ?? "Changement d'offre refusé") } }, status as 400 | 403 | 404);
  });
  return r;
}