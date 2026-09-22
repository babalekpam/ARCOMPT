import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createTestDatabase } from "@arcompt/db/testing";
import { authMiddleware } from "./auth.js";
import { linkSubject, resolveIdentity, touchLastActive, type Identity } from "./identity.js";

/**
 * Autorisation depuis la base : le jeton ne prouve que l'identité, les droits
 * viennent de company_member. Les cas du middleware sont joués avec un
 * résolveur factice (aucune base requise) ; la fonction SQL elle-même est
 * vérifiée dans la suite d'intégration en fin de fichier.
 */
const SUB = "keycloak-sub-1";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AUDIENCE = "arcompt-api";

// JWKS local : on signe de vrais jetons et le middleware les vérifie comme en production.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" }] };
const server = createServer((req, res) => {
  if (req.url?.endsWith("/protocol/openid-connect/certs")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(jwks));
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const ISSUER = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/test`;

afterAll(() => {
  server.close();
});

function token(claims: Record<string, unknown> = {}, sub = SUB): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

const identity = (over: Partial<Identity> = {}): Identity => ({
  userId: USER,
  organizationId: ORG,
  suspendedAt: null,
  mfaRequired: false,
  memberships: [{ companyId: TENANT, role: "CASHIER" }],
  ...over,
});

function appWith(resolved: Identity | null, touched: string[] = []) {
  const app = new Hono();
  app.use(
    "*",
    authMiddleware({
      mode: "oidc",
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveIdentity: async (sub) => (sub === SUB ? resolved : null),
      touchLastActive: async (userId) => void touched.push(userId),
    }),
  );
  app.get("/me", (c) => c.json(c.get("auth")));
  return app;
}

async function call(app: Hono, jwt: string, tenant: string | null = TENANT) {
  return app.request("/me", { headers: { authorization: `Bearer ${jwt}`, ...(tenant ? { "x-tenant-id": tenant } : {}) } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: Response): Promise<any> => res.json();

describe("middleware d'autorisation (identité en base)", () => {
  it("exige un résolveur en mode oidc", () => {
    expect(() => authMiddleware({ mode: "oidc", issuer: ISSUER })).toThrow(/résolveur/);
  });

  it("refuse un sujet inconnu de la base", async () => {
    const res = await call(appWith(identity()), await token({}, "sub-inconnu"));
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toMatch(/inconnu/i);
  });

  it("refuse un compte suspendu", async () => {
    const res = await call(appWith(identity({ suspendedAt: new Date("2025-01-01T00:00:00Z") })), await token());
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toMatch(/suspendu/i);
  });

  it("refuse un utilisateur sans aucune appartenance", async () => {
    const res = await call(appWith(identity({ memberships: [] })), await token());
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toMatch(/dossier/i);
  });

  it("refuse un dossier absent des appartenances, même annoncé par le jeton", async () => {
    const res = await call(appWith(identity()), await token({ tenants: { [OTHER]: ["OWNER"] } }), OTHER);
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toMatch(/non autorisé/i);
  });

  it("prend le rôle dans l'appartenance et non dans le jeton, et l'uuid utilisateur et non le sub", async () => {
    const touched: string[] = [];
    const res = await call(appWith(identity(), touched), await token({ tenants: { [TENANT]: ["OWNER"] }, organization_id: "org-du-jeton" }));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ userId: USER, tenantId: TENANT, organizationId: ORG, roles: ["CASHIER"] });
    expect(touched).toEqual([USER]);
  });

  it("refuse l'absence de second facteur quand l'organisation l'exige", async () => {
    const res = await call(appWith(identity({ mfaRequired: true })), await token({ amr: ["pwd"] }));
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toMatch(/multifacteur/i);
  });

  it("accepte un second facteur prouvé par amr ou par acr", async () => {
    const app = appWith(identity({ mfaRequired: true }));
    expect((await call(app, await token({ amr: ["pwd", "otp"] }))).status).toBe(200);
    expect((await call(app, await token({ amr: ["pwd", "hwk"] }))).status).toBe(200);
    expect((await call(app, await token({ acr: "2" }))).status).toBe(200);
    expect((await call(app, await token({ acr: "1" }))).status).toBe(403);
  });

  it("refuse un jeton invalide ou absent", async () => {
    const app = appWith(identity());
    expect((await app.request("/me", { headers: { "x-tenant-id": TENANT } })).status).toBe(401);
    expect((await call(app, "jeton.bidon.xyz")).status).toBe(401);
  });

  it("exige l'en-tête X-Tenant-Id", async () => {
    const res = await call(appWith(identity()), await token(), null);
    expect(res.status).toBe(403);
  });
});

/**
 * Intégration : auth_resolve_identity() doit fonctionner pour le rôle
 * applicatif alors que app_user et company_member sont en FORCE ROW LEVEL
 * SECURITY et qu'aucun contexte tenant n'est encore posé.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

afterAll(async () => {
  await env?.drop();
});

run("auth_resolve_identity", () => {
  it("résout l'utilisateur, son organisation et ses appartenances via le rôle applicatif", async () => {
    const db = env!.db;
    const appDb = env!.appDb;
    const [org] = await db`INSERT INTO organization (name, kind, mfa_required) VALUES ('Cabinet', 'FIRM', true) RETURNING id`;
    const orgId = org!.id as string;
    const [autre] = await db`INSERT INTO organization (name) VALUES ('Autre') RETURNING id`;
    const [user] = await db`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name) VALUES (${orgId}, 'sub-a', 'a@a.a', 'A') RETURNING id`;
    const [orphelin] = await db`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name) VALUES (${orgId}, 'sub-b', 'b@b.b', 'B') RETURNING id`;
    const company = async (organizationId: string, name: string) => {
      const [c] = await db`INSERT INTO company (organization_id, name, country_code, currency, pack_version)
                           VALUES (${organizationId}, ${name}, 'CI', 'XOF', 'ci@2025.1') RETURNING id`;
      return c!.id as string;
    };
    const a = await company(orgId, "Alpha");
    const b = await company(orgId, "Bêta");
    const hors = await company(autre!.id as string, "Hors organisation");
    await db`INSERT INTO company_member (company_id, user_id, role) VALUES (${a}, ${user!.id}, 'OWNER'), (${b}, ${user!.id}, 'AUDITOR'), (${hors}, ${user!.id}, 'OWNER')`;

    const resolved = await resolveIdentity(appDb, "sub-a");
    expect(resolved?.userId).toBe(user!.id);
    expect(resolved?.organizationId).toBe(orgId);
    expect(resolved?.mfaRequired).toBe(true);
    expect(resolved?.suspendedAt).toBeNull();
    // Le dossier d'une autre organisation n'apparaît jamais.
    expect([...resolved!.memberships].sort((x, y) => x.companyId.localeCompare(y.companyId))).toEqual(
      [{ companyId: a, role: "OWNER" }, { companyId: b, role: "AUDITOR" }].sort((x, y) => x.companyId.localeCompare(y.companyId)),
    );

    // Utilisateur connu mais sans appartenance : résolu, donc refusable avec un motif clair.
    const sansDossier = await resolveIdentity(appDb, "sub-b");
    expect(sansDossier?.userId).toBe(orphelin!.id);
    expect(sansDossier?.memberships).toEqual([]);

    // Sujet inconnu.
    expect(await resolveIdentity(appDb, "sub-inexistant")).toBeNull();

    // Suspension.
    await db`UPDATE app_user SET suspended_at = now() WHERE id = ${user!.id}`;
    expect((await resolveIdentity(appDb, "sub-a"))?.suspendedAt).toBeInstanceOf(Date);

    // Trace d'activité, alimentée par le middleware.
    expect((await db`SELECT last_active_at FROM app_user WHERE id = ${user!.id}`)[0]!.last_active_at).toBeNull();
    await touchLastActive(appDb, user!.id as string);
    expect((await db`SELECT last_active_at FROM app_user WHERE id = ${user!.id}`)[0]!.last_active_at).toBeInstanceOf(Date);
  });
});

run("auth_link_subject — rattachement au premier accès", () => {
  it("rattache sur courriel vérifié, refuse le vol de compte, l'ambiguïté et la réécriture", async () => {
    const db = env!.db;
    const appDb = env!.appDb;
    const [org] = await db`INSERT INTO organization (name) VALUES ('Rattachement') RETURNING id`;
    const orgId = org!.id as string;
    const nouveau = async (email: string, sub: string | null = null) => {
      const [u] = await db`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name)
                           VALUES (${orgId}, ${sub}, ${email}, 'X') RETURNING id`;
      return u!.id as string;
    };
    const subDe = async (id: string) => (await db`SELECT keycloak_sub FROM app_user WHERE id = ${id}`)[0]!.keycloak_sub;

    // Compte créé par le portail : aucun sub. Il se rattache au premier accès,
    // sans que personne n'écrive d'UPDATE à la main.
    const invite = await nouveau("invite@pme.ci");
    const resolu = await resolveIdentity(appDb, "sub-neuf", { email: "INVITE@PME.CI", emailVerified: true });
    expect(resolu?.userId).toBe(invite); // casse ignorée
    expect(await subDe(invite)).toBe("sub-neuf");

    // Courriel non vérifié : jamais de rattachement, sinon s'inscrire avec
    // l'adresse d'autrui suffirait à prendre son dossier.
    const jamais = await nouveau("jamais@pme.ci");
    expect(await resolveIdentity(appDb, "sub-pirate", { email: "jamais@pme.ci", emailVerified: false })).toBeNull();
    expect(await resolveIdentity(appDb, "sub-pirate", { email: "jamais@pme.ci" })).toBeNull();
    expect(await subDe(jamais)).toBeNull();

    // Un compte déjà rattaché n'est jamais réécrit par un autre sujet.
    const dejaLie = await nouveau("lie@pme.ci", "sub-original");
    expect(await resolveIdentity(appDb, "sub-usurpateur", { email: "lie@pme.ci", emailVerified: true })).toBeNull();
    expect(await subDe(dejaLie)).toBe("sub-original");

    // Un sujet déjà rattaché ne revendique pas un second compte.
    const autreCompte = await nouveau("autre@pme.ci");
    expect(await linkSubject(appDb, "sub-original", "autre@pme.ci")).toBeNull();
    expect(await subDe(autreCompte)).toBeNull();

    // Ambiguïté : deux comptes non rattachés pour la même adresse, on ne devine pas.
    const ambigu1 = await nouveau("double@pme.ci");
    const ambigu2 = await nouveau("double@pme.ci");
    expect(await linkSubject(appDb, "sub-ambigu", "double@pme.ci")).toBeNull();
    expect(await subDe(ambigu1)).toBeNull();
    expect(await subDe(ambigu2)).toBeNull();

    // Adresse inconnue : rien à rattacher.
    expect(await linkSubject(appDb, "sub-inconnu", "personne@pme.ci")).toBeNull();
  });
});
