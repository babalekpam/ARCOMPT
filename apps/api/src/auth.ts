import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Contexte d'authentification. Le tenant (dossier) vient TOUJOURS du jeton ou
 * d'une appartenance vérifiée, jamais d'un champ libre envoyé par le client.
 *
 * Deux modes :
 *  - AUTH_MODE=oidc : jeton Keycloak vérifié via JWKS ; le dossier courant est
 *    choisi par l'en-tête X-Tenant-Id et doit figurer dans les dossiers du jeton
 *    (claim `tenants`, ou rôle par dossier) ;
 *  - AUTH_MODE=dev : X-User-Id / X-Tenant-Id acceptés tels quels. Développement
 *    local uniquement ; refusé si NODE_ENV=production.
 */
export interface AuthContext {
  userId: string;
  tenantId: string;
  organizationId?: string;
  roles: string[];
}

export type Role = "OWNER" | "ACCOUNTANT" | "CASHIER" | "AUDITOR" | "REVIEWER";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export interface AuthOptions {
  mode: "dev" | "oidc";
  issuer?: string;
  audience?: string;
}

export function authMiddleware(opts: AuthOptions): MiddlewareHandler {
  if (opts.mode === "dev" && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev est interdit en production");
  }
  const jwks = opts.mode === "oidc" && opts.issuer ? createRemoteJWKSet(new URL(`${opts.issuer}/protocol/openid-connect/certs`)) : null;

  return async (c, next) => {
    const tenantHeader = c.req.header("x-tenant-id");
    if (opts.mode === "dev") {
      const userId = c.req.header("x-user-id");
      if (!userId || !tenantHeader) return unauthorized(c, "X-User-Id et X-Tenant-Id requis en mode dev");
      c.set("auth", { userId, tenantId: tenantHeader, roles: ["ACCOUNTANT"], ...(c.req.header("x-organization-id") ? { organizationId: c.req.header("x-organization-id")! } : {}) });
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token || !jwks) return unauthorized(c, "Jeton Bearer requis");
    let payload: JWTPayload & { tenants?: Record<string, string[]>; organization_id?: string };
    try {
      const verifyOptions = { ...(opts.issuer ? { issuer: opts.issuer } : {}), ...(opts.audience ? { audience: opts.audience } : {}) };
      payload = (await jwtVerify(token, jwks, verifyOptions)).payload;
    } catch {
      return unauthorized(c, "Jeton invalide");
    }
    const tenants = payload.tenants ?? {};
    if (!tenantHeader || !tenants[tenantHeader]) return forbidden(c, "Dossier non autorisé pour cet utilisateur");
    c.set("auth", {
      userId: String(payload.sub),
      tenantId: tenantHeader,
      roles: tenants[tenantHeader] ?? [],
      ...(payload.organization_id ? { organizationId: payload.organization_id } : {}),
    });
    return next();
  };
}

export function requireRole(...roles: Role[]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth.roles.some((r) => roles.includes(r as Role))) return forbidden(c, `Rôle requis : ${roles.join(" ou ")}`);
    return next();
  };
}

function unauthorized(c: Context, message: string) {
  return c.json({ error: { code: "UNAUTHORIZED", message } }, 401);
}

function forbidden(c: Context, message: string) {
  return c.json({ error: { code: "FORBIDDEN", message } }, 403);
}
