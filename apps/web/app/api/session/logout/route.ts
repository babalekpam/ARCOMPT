// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/** Déconnexion : efface les cookies applicatifs. Clerk termine sa session côté client. */
import { NextResponse } from "next/server";
import { COOKIES } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIES.dev, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.tenant, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.mfa, "", sessionCookieOptions(0));
  return res;
}
