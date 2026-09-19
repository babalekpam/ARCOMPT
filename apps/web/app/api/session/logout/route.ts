/** Déconnexion : efface les cookies applicatifs ; en OIDC, termine aussi la session Auth.js. */
import { NextResponse } from "next/server";
import { COOKIES, config } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";

export async function POST() {
  if (config.authMode() === "oidc") {
    const { signOut } = await import("@/auth");
    await signOut({ redirect: false });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIES.dev, "", sessionCookieOptions(0));
  res.cookies.set(COOKIES.tenant, "", sessionCookieOptions(0));
  return res;
}
