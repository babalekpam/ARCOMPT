// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/** Déconnexion : révoque la session Clerk côté serveur, puis efface les cookies applicatifs. */
import { NextResponse } from "next/server";
import { COOKIES, config } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";

export async function POST() {
  // Le signOut côté client ne suffit pas en production : la session Clerk
  // restait active après le clic (constaté le 2026-10-13 — l'utilisateur
  // « déconnecté » rouvrait son tableau de bord sans identifiants). La
  // révocation serveur via l'API Clerk est le chemin fiable ; le signOut
  // client ne sert plus qu'à nettoyer l'état local du navigateur.
  try {
    if (config.authMode() === "clerk") {
      const { auth, clerkClient } = await import("@clerk/nextjs/server");
      const session = await auth();
      const client = await clerkClient();
      // TOUTES les sessions actives de l'utilisateur, pas seulement celle de
      // la requête : un appareil peut porter plusieurs sessions Clerk
      // (navigateur + application installée, sessions résiduelles), et n'en
      // révoquer qu'une laissait l'utilisateur « à moitié déconnecté » — il
      // devait cliquer deux fois (constaté le 2026-10-13 au soir). Un clic =
      // déconnexion partout, déterministe.
      const ids = new Set<string>();
      if (session.sessionId) ids.add(session.sessionId);
      if (session.userId) {
        const list = (await client.sessions.getSessionList({ userId: session.userId, status: "active", limit: 50 })) as unknown as {
          data: Array<{ id: string }>;
        };
        for (const s of list.data ?? []) ids.add(s.id);
      }
      for (const id of ids) {
        await client.sessions.revokeSession(id).catch(() => { /* déjà révoquée ou expirée */ });
      }
    }
  } catch {
    // La déconnexion locale continue quoi qu'il arrive.
  }
  const res = NextResponse.json({ ok: true });
  // Effacer aussi les cookies Clerk eux-mêmes : le JWT __session reste
  // « valide en apparence » jusqu'à ~60 s après la révocation (vérification
  // locale sans appel réseau), ce qui laissait l'application se rouvrir une
  // fois avant de retomber sur l'écran de connexion. Sans __session ni
  // __client dans le navigateur, la déconnexion est immédiate et finale.
  if (config.authMode() === "clerk") {
    for (const name of ["__session", "__client", "__clerk_db_jwt"]) {
      res.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
  }
  res.cookies.set(COOKIES.dev, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.tenant, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.mfa, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.adminMode, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.customerTenant, "", sessionCookieOptions(0));
  return res;
}
