// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Identity, PlatformAdminIdentity, PlatformCompany, TokenIdentityHints } from "./identity.js";
import { log } from "./telemetry.js";

/**
 * Contexte d'authentification. Keycloak authentifie, ARCOMPT autorise : le
 * jeton ne sert qu'à prouver l'identité (`sub`) ; les dossiers accessibles et
 * les rôles sont lus dans `company_member`, jamais dans un claim recopié.
 *
 * Deux modes :
 *  - AUTH_MODE=oidc : jeton vérifié contre le trousseau du fournisseur, dont
 *    l'URL est obtenue par découverte OpenID Connect (`jwks_uri` du document
 *    `/.well-known/openid-configuration`) — donc n'importe quel fournisseur
 *    conforme, Keycloak comme un service hébergé —, puis résolution de
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
  /**
   * Langue de travail de l'opérateur (`app_user.locale`). Dernier échelon de la
   * règle de langue : elle ne décide que d'un document sans destinataire dans un
   * dossier dont la langue n'est pas renseignée (packages/render/src/locale.ts).
   */
  locale?: string;
  /** True only when the Clerk subject is present in platform_admin_identity. */
  platformAdmin?: boolean;
  /** Verified Clerk subject, for platform discovery callbacks only. */
  platformSub?: string;
}

export type Role = "OWNER" | "ACCOUNTANT" | "CASHIER" | "AUDITOR" | "REVIEWER";

/**
 * Valeurs `amr` (RFC 8176) acceptées comme preuve d'un second facteur, et seuil
 * `acr` équivalent. Liste volontairement courte et exportée : c'est le seul
 * endroit à ajuster si le fournisseur d'identité en émet d'autres.
 */
export const MFA_AMR_VALUES = ["mfa", "otp", "hwk", "swk"] as const;
export const MFA_MIN_ACR = 2;

// ---------------------------------------------------------------------------
// Découverte OpenID Connect
// ---------------------------------------------------------------------------

/**
 * Chemin normalisé du document de découverte (OpenID Connect Discovery 1.0,
 * § 4). Tout fournisseur conforme le sert ; c'est lui qui donne l'URL du
 * trousseau de clés publiques (`jwks_uri`).
 *
 * Auparavant l'URL était fabriquée en collant `/protocol/openid-connect/certs`
 * à l'émetteur. Ce chemin est celui de Keycloak, et de lui seul : il rendait
 * tout autre fournisseur (Auth0, Microsoft Entra ID, Okta, Google, Zitadel…)
 * impossible à brancher, chacun plaçant son trousseau ailleurs.
 */
export const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";

/**
 * Échappatoire : impose l'URL du trousseau sans passer par la découverte, pour
 * les rares fournisseurs qui ne publient pas de document conforme, ou qui le
 * publient sur un hôte différent de l'émetteur.
 */
export const JWKS_URI_ENV = "OIDC_JWKS_URI";

/** Au-delà, la découverte est considérée injoignable. */
export const DISCOVERY_TIMEOUT_MS = 5_000;

/** Échec de découverte : porte un message directement exploitable par l'exploitant. */
export class OidcDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcDiscoveryError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Un émetteur ne diffère jamais d'un autre par sa seule barre oblique finale. */
function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

export interface DiscoverOptions {
  /** Injectable : les tests ne doivent pas atteindre le réseau. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Lit `${issuer}/.well-known/openid-configuration` et en extrait `jwks_uri`.
 *
 * Trois refus délibérés, tous avec un message nommant l'URL interrogée :
 *  - document injoignable, non-JSON, ou réponse non 2xx ;
 *  - `jwks_uri` absent ou inexploitable comme URL absolue ;
 *  - `issuer` déclaré différent de celui configuré — c'est la vérification que
 *    demande la spécification, et la seule protection contre un `KEYCLOAK_ISSUER`
 *    qui pointerait vers un document de découverte étranger.
 */
export async function discoverJwksUri(issuer: string, opts: DiscoverOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${normalizeIssuer(issuer)}${OIDC_DISCOVERY_PATH}`;
  const hint = `Vérifiez KEYCLOAK_ISSUER, ou imposez l'URL du trousseau avec ${JWKS_URI_ENV}.`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS) });
  } catch (e) {
    throw new OidcDiscoveryError(`Découverte OpenID Connect injoignable (${url}) : ${e instanceof Error ? e.message : String(e)}. ${hint}`);
  }
  if (!response.ok) {
    throw new OidcDiscoveryError(`Découverte OpenID Connect en échec (${url}) : HTTP ${response.status}. ${hint}`);
  }

  let document: unknown;
  try {
    document = await response.json();
  } catch (e) {
    throw new OidcDiscoveryError(`Découverte OpenID Connect illisible (${url}) : réponse non JSON (${e instanceof Error ? e.message : String(e)}). ${hint}`);
  }
  const doc = (document ?? {}) as { jwks_uri?: unknown; issuer?: unknown };

  if (typeof doc.issuer === "string" && normalizeIssuer(doc.issuer) !== normalizeIssuer(issuer)) {
    throw new OidcDiscoveryError(
      `Découverte OpenID Connect incohérente (${url}) : le document déclare l'émetteur « ${doc.issuer} », la configuration attend « ${issuer} ». Les jetons seraient rejetés. ${hint}`,
    );
  }
  if (typeof doc.jwks_uri !== "string" || doc.jwks_uri.trim() === "") {
    throw new OidcDiscoveryError(`Découverte OpenID Connect inexploitable (${url}) : aucun « jwks_uri » dans le document. ${hint}`);
  }
  try {
    return new URL(doc.jwks_uri.trim()).toString();
  } catch {
    throw new OidcDiscoveryError(`Découverte OpenID Connect inexploitable (${url}) : « jwks_uri » n'est pas une URL absolue (« ${doc.jwks_uri} »). ${hint}`);
  }
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export interface AuthOptions {
  mode: "dev" | "oidc" | "clerk";
  issuer?: string;
  audience?: string;
  /** Replit-managed Clerk backend secret. Required in Clerk mode. */
  clerkSecretKey?: string;
  /** Exact frontend origins allowed to mint the session token (`azp`). */
  authorizedParties?: string[];
  /** Injectable official Clerk user lookup, used only for first-login linking. */
  clerkUserLookup?: (userId: string) => Promise<{ email?: string; emailVerified: boolean } | null>;
  /**
   * URL du trousseau imposée à la main, court-circuitant la découverte.
   * Par défaut la variable d'environnement `OIDC_JWKS_URI`.
   */
  jwksUri?: string;
  /** Découverte injectable : les tests ne touchent jamais le réseau. */
  discover?: (issuer: string) => Promise<string>;
  /** Environnement lu pour l'échappatoire `OIDC_JWKS_URI` ; injectable. */
  env?: NodeJS.ProcessEnv;
  /** Résolution des droits en base ; injectable pour tester le middleware sans PostgreSQL. */
  resolveIdentity?: (sub: string, hints: TokenIdentityHints) => Promise<Identity | null>;
  /** Trace d'activité, au mieux : son échec ne doit jamais bloquer la requête. */
  touchLastActive?: (userId: string) => Promise<void>;
  /** Platform privilege is resolved independently of ordinary memberships. */
  resolvePlatformAdmin?: (sub: string) => Promise<PlatformAdminIdentity | null>;
  resolvePlatformCompany?: (sub: string, companyId: string) => Promise<{ companyId: string; organizationId: string } | null>;
  resolvePlatformCompanies?: (sub: string) => Promise<PlatformCompany[]>;
  recordPlatformAccess?: (sub: string, companyId: string | null, method: string, path: string) => Promise<void>;
}

/** Trousseau de clés tel que `jose` l'attend. */
type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

/**
 * Résout le trousseau **paresseusement**, et une seule fois.
 *
 * La découverte est un appel réseau : la faire au chargement du module
 * empêcherait l'API de démarrer quand le fournisseur d'identité est
 * momentanément indisponible, et rendrait tout test dépendant du réseau. Elle
 * est donc déclenchée à la première requête portant un jeton, puis mémorisée.
 *
 * Un échec n'est pas mémorisé : la promesse en cours est oubliée, et la requête
 * suivante réessaie. Une panne passagère du fournisseur ne condamne pas le
 * processus jusqu'à son redémarrage.
 */
function jwksResolverFor(opts: AuthOptions): () => Promise<JwksResolver> {
  const issuer = opts.issuer!;
  const env = opts.env ?? process.env;
  const override = (opts.jwksUri ?? env[JWKS_URI_ENV] ?? "").trim();
  const discover = opts.discover ?? ((iss: string) => discoverJwksUri(iss));

  let cached: JwksResolver | null = null;
  let pending: Promise<JwksResolver> | null = null;

  return () => {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      pending = (async () => {
        const uri = override !== "" ? override : await discover(issuer);
        const resolver = createRemoteJWKSet(new URL(uri));
        cached = resolver;
        log("info", "auth.jwks.resolved", { issuer, jwksUri: uri, source: override !== "" ? JWKS_URI_ENV : "discovery" });
        return resolver;
      })();
      pending.catch(() => undefined).then(() => { if (!cached) pending = null; });
    }
    return pending;
  };
}

export function authMiddleware(opts: AuthOptions): MiddlewareHandler {
  if (opts.mode === "dev" && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev est interdit en production");
  }
  const resolve = opts.resolveIdentity;
  if ((opts.mode === "oidc" || opts.mode === "clerk") && !resolve) {
    throw new Error(`AUTH_MODE=${opts.mode} exige un résolveur d'identité (base de données)`);
  }
  const jwksFor = opts.mode === "oidc" && opts.issuer ? jwksResolverFor(opts) : null;
  const clerkLookup = opts.clerkUserLookup ?? (opts.clerkSecretKey
    ? async (userId: string) => {
        const user = await createClerkClient({ secretKey: opts.clerkSecretKey! }).users.getUser(userId);
        const address = user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId);
        return address
          ? { email: address.emailAddress, emailVerified: address.verification?.status === "verified" }
          : null;
      }
    : null);
  if (opts.mode === "clerk" && (!opts.clerkSecretKey || !clerkLookup || !opts.authorizedParties?.length)) {
    throw new Error("AUTH_MODE=clerk exige CLERK_SECRET_KEY, CLERK_AUTHORIZED_PARTIES et un résolveur Clerk");
  }

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
    if (!token) return unauthorized(c, "Jeton Bearer requis");

    if (opts.mode === "clerk") {
      let payload: JWTPayload & { fva?: unknown; azp?: unknown };
      try {
        payload = await verifyToken(token, {
          secretKey: opts.clerkSecretKey!,
          authorizedParties: opts.authorizedParties,
          headerType: "Bearer",
        }) as JWTPayload & { fva?: unknown; azp?: unknown };
      } catch {
        return unauthorized(c, "Jeton Clerk invalide");
      }
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      // Clerk session tokens carry sid; rejecting tokens without it prevents a
      // verified machine/JWT-template token from being accepted as a browser session.
      if (!sub || typeof payload.sid !== "string" || payload.sid.length === 0) return unauthorized(c, "Jeton Clerk sans session (sub/sid)");
      const platformAdmin = opts.resolvePlatformAdmin ? await opts.resolvePlatformAdmin(sub) : null;
      if (platformAdmin) {
        if (platformAdmin.suspendedAt) return forbidden(c, "Compte suspendu : contactez l'administrateur");
        if (!hasClerkSecondFactor(payload.fva)) return forbidden(c, "Authentification multifacteur requise pour l'administration de la plateforme");
        // Hono normally retains the mounted `/v1` prefix; accept the
        // sub-router form as well so this remains correct in isolated tests.
        const platformPath = c.req.path === "/v1/platform" || c.req.path.startsWith("/v1/platform/") || c.req.path === "/platform" || c.req.path.startsWith("/platform/");
        if (!tenantHeader && !platformPath) return forbidden(c, "Un tenant est requis hors des routes plateforme");
        let tenantId = "";
        let organizationId: string | undefined;
        if (tenantHeader) {
          if (!UUID_RE.test(tenantHeader)) return forbidden(c, "X-Tenant-Id doit être un UUID");
          const company = opts.resolvePlatformCompany ? await opts.resolvePlatformCompany(sub, tenantHeader) : null;
          if (!company) return forbidden(c, "Dossier non autorisé pour cet administrateur");
          tenantId = company.companyId;
          organizationId = company.organizationId;
        }
        if (!opts.recordPlatformAccess) return c.json({ error: { code: "AUDIT_UNAVAILABLE", message: "Journal d'accès indisponible" } }, 503);
        try {
          await opts.recordPlatformAccess(sub, tenantId || null, c.req.method, c.req.path);
        } catch {
          return c.json({ error: { code: "AUDIT_UNAVAILABLE", message: "Journal d'accès indisponible" } }, 503);
        }
        c.set("auth", {
          userId: platformAdmin.userId,
          tenantId,
          roles: tenantId ? ["OWNER"] : [],
          platformAdmin: true,
          platformSub: sub,
          ...(organizationId ? { organizationId } : {}),
          ...(platformAdmin.locale ? { locale: platformAdmin.locale } : {}),
        });
        return next();
      }
      const existing = resolve ? await resolve(sub, {}) : null;
      let identity = existing;
      if (!identity) {
        try {
          const account = await clerkLookup!(sub);
          if (account?.email && account.emailVerified) {
            identity = await resolve!(sub, { email: account.email, emailVerified: true });
          }
        } catch {
          // A provider lookup outage must not turn into an authorization grant.
          return c.json({ error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "Profil Clerk inexploitable" } }, 503);
        }
      }
      if (!identity) return forbidden(c, "Compte inconnu dans ARCOMPT : aucun utilisateur ne correspond à ce sujet Clerk");
      if (identity.suspendedAt) return forbidden(c, "Compte suspendu : contactez l'administrateur de votre organisation");
      if (identity.memberships.length === 0) return forbidden(c, "Aucun dossier accessible : demandez à être ajouté comme membre");
      if (identity.mfaRequired && !hasClerkSecondFactor(payload.fva)) {
        return forbidden(c, "Authentification multifacteur requise par votre organisation : reconnectez-vous avec un second facteur");
      }
      if (!tenantHeader) return forbidden(c, "En-tête X-Tenant-Id requis");
      const membership = identity.memberships.find((m) => m.companyId === tenantHeader);
      if (!membership) return forbidden(c, "Dossier non autorisé pour cet utilisateur");
      c.set("auth", { userId: identity.userId, tenantId: membership.companyId, roles: [membership.role], organizationId: identity.organizationId, ...(identity.locale ? { locale: identity.locale } : {}) });
      if (opts.touchLastActive) void opts.touchLastActive(identity.userId);
      return next();
    }
    if (!jwksFor) return unauthorized(c, "Configuration OIDC absente");

    // Le trousseau est résolu à la première requête, jamais au chargement du
    // module. Son indisponibilité n'est pas un jeton invalide : la distinguer
    // évite de faire chercher une erreur d'authentification là où le
    // fournisseur d'identité est simplement injoignable ou mal configuré.
    let jwks: JwksResolver;
    try {
      jwks = await jwksFor();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log("error", "auth.jwks.unavailable", { issuer: opts.issuer, detail });
      return c.json({ error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: `Fournisseur d'identité inexploitable : ${detail}` } }, 503);
    }

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

    c.set("auth", { userId: identity.userId, tenantId: membership.companyId, roles: [membership.role], organizationId: identity.organizationId, ...(identity.locale ? { locale: identity.locale } : {}) });
    if (opts.touchLastActive) void opts.touchLastActive(identity.userId);
    return next();
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Clerk's `fva` is [first-factor verification age, second-factor age]. */
function hasClerkSecondFactor(fva: unknown): boolean {
  if (!Array.isArray(fva) || fva.length !== 2) return false;
  return typeof fva[1] === "number" && Number.isFinite(fva[1]) && fva[1] >= 0;
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
