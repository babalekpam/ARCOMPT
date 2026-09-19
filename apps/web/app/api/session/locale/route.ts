/** Sélecteur de langue : cookie `arcompt_locale` (fr | en). */
import { NextResponse, type NextRequest } from "next/server";
import { COOKIES } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";
import { isLocale } from "@/lib/i18n";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { locale?: string };
  if (!isLocale(body.locale)) return NextResponse.json({ error: { code: "VALIDATION", message: "locale fr ou en" } }, { status: 400 });
  const res = NextResponse.json({ ok: true, locale: body.locale });
  res.cookies.set(COOKIES.locale, body.locale, { ...sessionCookieOptions(60 * 60 * 24 * 365), httpOnly: false });
  return res;
}
