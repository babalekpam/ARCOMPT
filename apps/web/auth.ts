// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Auth.js v5 : fournisseur Keycloak (OIDC) configuré depuis l'environnement.
 * Le jeton d'accès est conservé dans le JWT de session pour être transmis à
 * l'API en `Authorization: Bearer`. En AUTH_MODE=dev, ce module est inerte :
 * la session vient du cookie de connexion de développement (lib/auth.ts).
 */
import NextAuth, { type NextAuthConfig } from "next-auth";
import Keycloak from "next-auth/providers/keycloak";
import { config } from "./lib/config";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    organizationId?: string;
    subjectId?: string;
  }
}

const kc = config.keycloak();
const keycloak = kc.issuer && kc.clientId && kc.clientSecret ? { issuer: kc.issuer, clientId: kc.clientId, clientSecret: kc.clientSecret } : null;
export const keycloakConfigured = keycloak !== null;

const authConfig: NextAuthConfig = {
  trustHost: true,
  // Un secret de repli évite un plantage au démarrage en mode dev ; en OIDC, AUTH_SECRET est obligatoire.
  secret: config.authSecret() ?? (config.authMode() === "dev" ? "arcompt-dev-secret-change-me" : undefined),
  session: { strategy: "jwt" },
  providers: keycloak ? [Keycloak(keycloak)] : [],
  pages: { signIn: "/login" },
  callbacks: {
    jwt({ token, account, profile }) {
      // Premier passage après connexion : on garde le jeton d'accès et l'organisation du profil.
      if (account?.access_token) {
        token.accessToken = account.access_token;
        token.accessTokenExpires = typeof account.expires_at === "number" ? account.expires_at * 1000 : undefined;
      }
      const org = (profile as { organization_id?: string } | undefined)?.organization_id;
      if (org) token.organizationId = org;
      return token;
    },
    session({ session, token }) {
      session.accessToken = typeof token.accessToken === "string" ? token.accessToken : undefined;
      session.organizationId = typeof token.organizationId === "string" ? token.organizationId : undefined;
      session.subjectId = typeof token.sub === "string" ? token.sub : undefined;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
