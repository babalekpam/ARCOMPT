import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Identity, TokenIdentityHints } from "./identity.js";

/**
 * Contexte d'authentification. Keycloak authentifie, ARCOMPT autorise : le
 * jeton ne sert qu'à prouver l'identité (`sub`) ; les dossiers accessibles et
 * les rôles sont lus dans `company_member`, jamais dans un claim recopié.
 *
 * Deux modes :
 *  - AUTH_MODE=oidc : jeton Keycloak vérifié via JWKS, puis résolution de
 *    l'identité en base (auth_resolve_identity). Le dossier courant est choisi
 *    par l'en-tête X-Tenant-Id et doit correspondre à une appartenance ; le
 *    rôle vient de cette appartenance, l'organisation de `app_user`. Un compte
 *    suspendu, sans appartenance, ou sans second facteur lorsque
 *    `organization.mfa_required` est vrai, est refusé ;
 *  - AUTH_MODE=dev : X-User-Id / X-Tenant-Id acceptés tels quels. Développement
 *    local uniquement ; refusé si NODE_ENV=production.
 */
export interface AuthContext {
  /** `app_user.id` (uuid) en mode oidc : il alimente audit_log.user_id et app.user_id. */
  userId: string;
  tenantId: string;
  organizationId?: string;
  roles: string[];
}

export type Role = "OWNER" | "ACCOUNTANT" | "CASHIER" | "AUDITOR" | "REVIEWER";

/**
 * Valeurs `amr` (RFC 8176) acceptées comme preuve d'un second facteur, et seuil
 * `acr` équivalent. Liste volontairement courte et exportée : c'est le seul
 * endroit à ajuster si le fournisseur d'identité en émet d'autres.
 */
export const MFA_AMR_VALUES = ["mfa", "otp", "hwk", "swk"] as const;
export const MFA_MIN_ACR = 2;

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export interface AuthOptions {
  mode: "dev" | "oidc";
  issuer?: string;
  audience?: string;
  /** Résolution des droits en base ; injectable pour tester le middleware sans PostgreSQL. */
  resolveIdentity?: (sub: string, hints: TokenIdentityHints) => Promise<Identity | null>;
  /** Trace d'activité, au mieux : son échec ne doit jamais bloquer la requête. */
  touchLastActive?: (userId: string) => Promise<void>;
}

export function authMiddleware(opts: AuthOptions): MiddlewareHandler {
  if (opts.mode === "dev" && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev est interdit en production");
  }
  const resolve = opts.resolveIdentity;
  if (opts.mode === "oidc" && !resolve) {
    throw new Error("AUTH_MODE=oidc exige un résolveur d'identité (base de données)");
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
    let payload: JWTPayload & { amr?: unknown; acr?: unknown; email?: unknown; email_verified?: unknown };
    try {
      const verifyOptions = { ...(opts.issuer ? { issuer: opts.issuer } : {}), ...(opts.audience ? { audience: opts.audience } : {}) };
      payload = (await jwtVerify(token, jwks, verifyOptions)).payload;
    } catch {
      return unauthorized(c, "Jeton invalide");
    }
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) return unauthorized(c, "Jeton sans sujet (sub)");

    // Le courriel ne sert qu'au rattachement au premier accès, et seulement
    // s'il est vérifié par le fournisseur d'identité : sinon, s'inscrire avec
    // l'adresse d'autrui suffirait à récupérer son dossier.
    const hints: TokenIdentityHints = {
      ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      ...(payload.email_verified === true ? { emailVerified: true } : {}),
    };
    const identity = resolve ? await resolve(sub, hints) : null;
    if (!identity) return forbidden(c, "Compte inconnu dans ARCOMPT : aucun utilisateur ne correspond à ce sujet Keycloak");
    if (identity.suspendedAt) return forbidden(c, "Compte suspendu : contactez l'administrateur de votre organisation");
    if (identity.memberships.length === 0) return forbidden(c, "Aucun dossier accessible : demandez à être ajouté comme membre");
    if (identity.mfaRequired && !hasSecondFactor(payload)) {
      return forbidden(c, "Authentification multifacteur requise par votre organisation : reconnectez-vous avec un second facteur");
    }
    if (!tenantHeader) return forbidden(c, "En-tête X-Tenant-Id requis");
    const membership = identity.memberships.find((m) => m.companyId === tenantHeader);
    if (!membership) return forbidden(c, "Dossier non autorisé pour cet utilisateur");

    c.set("auth", { userId: identity.userId, tenantId: membership.companyId, roles: [membership.role], organizationId: identity.organizationId });
    if (opts.touchLastActive) void opts.touchLastActive(identity.userId);
    return next();
  };
}

/** Second facteur prouvé par le claim `amr` (RFC 8176) ou par un `acr` suffisant. */
function hasSecondFactor(payload: { amr?: unknown; acr?: unknown }): boolean {
  const amr = Array.isArray(payload.amr) ? payload.amr : [];
  if (amr.some((v) => typeof v === "string" && (MFA_AMR_VALUES as readonly string[]).includes(v.toLowerCase()))) return true;
  const acr = Number(payload.acr);
  return Number.isFinite(acr) && acr >= MFA_MIN_ACR;
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
