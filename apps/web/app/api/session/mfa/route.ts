// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ApiError, ApiUnreachableError, apiFetch } from "@/lib/api";
import { COOKIES } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";
import { acceptsMutationOrigin } from "@/lib/proxy-origin";

export const dynamic = "force-dynamic";
const paths = {
  enroll: "/security/mfa/enroll",
  confirm: "/security/mfa/confirm",
  verify: "/security/mfa/verify",
  "recovery-codes": "/security/mfa/recovery-codes",
} as const;

function failure(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  if (error instanceof ApiUnreachableError) return NextResponse.json({ error: { code: "UPSTREAM_UNREACHABLE", message: "Service de sécurité indisponible. Réessayez plus tard." } }, { status: 502, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ error: { code: "MFA_CONFIG", message: "Configuration de sécurité indisponible. Contactez l’administration." } }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    if (!await getAuthContext()) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Connectez-vous à nouveau." } }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const status = await apiFetch<{ enabled: boolean; verified: boolean; expiresAt?: string }>("/security/mfa/status", { headers: { "X-Tenant-Id": "" } });
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  if (!acceptsMutationOrigin(req)) return NextResponse.json({ error: { code: "FORBIDDEN", message: "Origine non autorisée." } }, { status: 403, headers: { "Cache-Control": "no-store" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "VALIDATION", message: "Requête JSON invalide." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: { code: "VALIDATION", message: "Requête invalide." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const { action, code } = body as { action?: unknown; code?: unknown };
  if (typeof action !== "string" || !Object.hasOwn(paths, action) || (action !== "enroll" && (typeof code !== "string" || (action === "verify" ? !code.trim() || code.length > 128 : !/^[0-9]{6}$/.test(code))))) {
    return NextResponse.json({ error: { code: "VALIDATION", message: "Action ou code invalide." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    if (!await getAuthContext()) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Connectez-vous à nouveau." } }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const data = await apiFetch<Record<string, unknown>>(paths[action as keyof typeof paths], {
      method: "POST", body: action === "enroll" ? {} : { code },
      headers: { "X-Tenant-Id": "" },
    });
    // The proof is exclusively a server-set cookie, never returned in JSON.
    const { proof, expiresAt, ...safe } = data;
    const response = NextResponse.json({ ...safe, ...(typeof expiresAt === "string" ? { expiresAt } : {}) }, { headers: { "Cache-Control": "no-store" } });
    if (action === "confirm" || action === "verify") {
      if (typeof proof !== "string" || !proof || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
        return failure(new Error("Invalid MFA response"));
      }
      const maxAge = Math.min(15 * 60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
      if (maxAge <= 0) return failure(new Error("Expired MFA proof"));
      response.cookies.set(COOKIES.mfa, proof, sessionCookieOptions(maxAge));
    } else if (action === "recovery-codes") {
      // Regeneration invalidates every existing proof on the API.
      response.cookies.set(COOKIES.mfa, "", sessionCookieOptions(0));
    }
    return response;
  } catch (error) {
    return failure(error);
  }
}