// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Connexion de développement (AUTH_MODE=dev uniquement) : enregistre
 * {userId, tenantId, organizationId} dans un cookie httpOnly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { UUID_RE } from "@/lib/auth";
import { COOKIES, config } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";

export async function POST(req: NextRequest) {
  if (config.authMode() !== "dev") return NextResponse.json({ error: { code: "FORBIDDEN", message: "Connexion dev désactivée" } }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { userId?: string; tenantId?: string; organizationId?: string };
  const userId = body.userId?.trim();
  const tenantId = body.tenantId?.trim();
  const organizationId = body.organizationId?.trim();
  if (!userId || !tenantId) return NextResponse.json({ error: { code: "VALIDATION", message: "userId et tenantId requis" } }, { status: 400 });
  if (!UUID_RE.test(tenantId)) return NextResponse.json({ error: { code: "VALIDATION", message: "tenantId doit être un UUID" } }, { status: 400 });
  if (organizationId && !UUID_RE.test(organizationId)) return NextResponse.json({ error: { code: "VALIDATION", message: "organizationId doit être un UUID" } }, { status: 400 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIES.dev, JSON.stringify({ userId, tenantId, ...(organizationId ? { organizationId } : {}) }), sessionCookieOptions());
  res.cookies.set(COOKIES.tenant, tenantId, sessionCookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIES.dev, "", { ...sessionCookieOptions(0) });
  res.cookies.set(COOKIES.tenant, "", { ...sessionCookieOptions(0) });
  return res;
}
