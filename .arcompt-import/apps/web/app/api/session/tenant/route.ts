// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/** Sélecteur de dossier : mémorise le dossier courant dans un cookie httpOnly. */
import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext, UUID_RE } from "@/lib/auth";
import { COOKIES } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";

export async function POST(req: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Session absente" } }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { tenantId?: string };
  const tenantId = body.tenantId?.trim();
  if (!tenantId || !UUID_RE.test(tenantId)) return NextResponse.json({ error: { code: "VALIDATION", message: "tenantId doit être un UUID" } }, { status: 400 });
  const res = NextResponse.json({ ok: true, tenantId });
  res.cookies.set(COOKIES.tenant, tenantId, sessionCookieOptions());
  return res;
}
