// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext, UUID_RE } from "@/lib/auth";
import { apiTry, ApiError } from "@/lib/api";
import { COOKIES } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";
import type { PlatformMe } from "@/lib/platform";

interface Memberships {
  companies: Array<{ id: string; role: string }>;
  canBootstrap?: boolean;
}

function rejectedDestination(error: unknown): string {
  if (!(error instanceof ApiError)) return "/access-pending?reason=unavailable";
  if (error.status === 401) return "/access-pending?reason=session";
  if (error.code === "ACCOUNT_SUSPENDED") return "/access-pending?reason=suspended";
  if (error.code === "MFA_REQUIRED") return "/access-pending?reason=mfa";
  return error.status === 403 ? "/access-pending?reason=denied" : "/access-pending?reason=unavailable";
}

/** A single sign-in destination; all authorization comes from the API. */
export async function GET(_req: NextRequest) {
  const auth = await getAuthContext();
  // Relative Location retains the browser's public host behind Replit's proxy.
  const destination = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path } });
  if (!auth) return destination("/login");
  if (auth.mode !== "clerk") return destination("/dashboard");

  const withoutTenant = { headers: { "X-Tenant-Id": "" } };
  const platform = await apiTry<PlatformMe>("/platform/me", withoutTenant);
  if (platform.ok && platform.data.platformAdmin) {
    const res = destination("/platform");
    res.cookies.set(COOKIES.tenant, "", sessionCookieOptions(0));
    return res;
  }
  // Only a definite "not a platform admin" may fall through to tenant
  // discovery. Outages and expired sessions must not be treated as roles.
  if (!platform.ok && (!(platform.error instanceof ApiError) || platform.error.status !== 403 || platform.error.code !== "FORBIDDEN")) {
    return destination(rejectedDestination(platform.error));
  }

  const memberships = await apiTry<Memberships>("/session/memberships", withoutTenant);
  if (!memberships.ok) return destination(rejectedDestination(memberships.error));
  const allowed = memberships.data.companies.map((company) => company.id).filter((id) => UUID_RE.test(id));
  if (!allowed.length) {
    const res = destination(memberships.data.canBootstrap === true ? "/onboarding" : "/access-pending");
    res.cookies.set(COOKIES.tenant, "", sessionCookieOptions(0));
    return res;
  }
  const selected = allowed.includes(auth.tenantId ?? "") ? auth.tenantId! : allowed[0]!;
  const res = destination("/dashboard");
  if (selected !== auth.tenantId) res.cookies.set(COOKIES.tenant, selected, sessionCookieOptions());
  return res;
}