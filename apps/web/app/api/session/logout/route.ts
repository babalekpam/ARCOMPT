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
      if (session.sessionId) {
        const client = await clerkClient();
        await client.sessions.revokeSession(session.sessionId);
      }
    }
  } catch {
    // La déconnexion locale continue quoi qu'il arrive.
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIES.dev, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.tenant, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.mfa, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.adminMode, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.customerTenant, "", sessionCookieOptions(0));
  return res;
}
