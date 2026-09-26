import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext, UUID_RE } from "@/lib/auth";
import { ApiError, apiFetch } from "@/lib/api";
import { COOKIES } from "@/lib/config";
import { sessionCookieOptions } from "@/lib/cookies";
import { acceptsMutationOrigin } from "@/lib/proxy-origin";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  return NextResponse.json({ error: { code: error instanceof ApiError ? error.code : "ADMIN_MODE_UNAVAILABLE",
    message: error instanceof ApiError ? error.message : "Service d’administration indisponible. Réessayez." } },
  { status: error instanceof ApiError ? error.status : 503, headers: noStore });
}
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthContext();
    if (!auth) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401, headers: noStore });
    const status = await apiFetch<{ eligible: boolean; active: boolean; expiresAt: string | null }>("/security/admin-mode/status", { headers: { "X-Tenant-Id": "" } });
    return NextResponse.json({ eligible: status.eligible === true, active: status.active === true, expiresAt: status.expiresAt,
      canReturn: !!req.cookies.get(COOKIES.customerTenant)?.value }, { headers: noStore });
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  if (!acceptsMutationOrigin(req)) return NextResponse.json({ error: { code: "FORBIDDEN", message: "Origine non autorisée" } }, { status: 403, headers: noStore });
  const body = await req.json().catch(() => null);
  if (body?.action !== "activate" && body?.action !== "deactivate") return NextResponse.json({ error: { code: "VALIDATION" } }, { status: 400, headers: noStore });
  try {
    const auth = await getAuthContext();
    if (!auth) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401, headers: noStore });
    if (body.action === "activate") {
      const data = await apiFetch<{ token: string; expiresAt: string }>("/security/admin-mode/activate", { method: "POST", body: {}, headers: { "X-Tenant-Id": "" } });
      const maxAge = Math.min(900, Math.floor((Date.parse(data.expiresAt) - Date.now()) / 1000));
      if (!/^[A-Za-z0-9_-]{43}$/.test(data.token) || !Number.isFinite(maxAge) || maxAge <= 0) return failure(new Error("Invalid mode"));
      const response = NextResponse.json({ active: true, expiresAt: data.expiresAt }, { headers: noStore });
      response.cookies.set(COOKIES.adminMode, data.token, sessionCookieOptions(maxAge));
      // Retain the original customer selection when reactivating an expired mode.
      let savedForThisUser = false;
      try {
        const saved = JSON.parse(req.cookies.get(COOKIES.customerTenant)?.value ?? "{}");
        savedForThisUser = saved.sub === auth.userId && !!auth.sessionId && saved.sid === auth.sessionId;
      } catch { /* discard malformed selection */ }
      if (!savedForThisUser) {
        // A stale marker from another login/session means the current tenant
        // might still be an administrative selection: do not preserve it.
        response.cookies.set(COOKIES.customerTenant, JSON.stringify({ sub: auth.userId, sid: auth.sessionId,
          tenant: req.cookies.get(COOKIES.customerTenant)?.value ? null : auth.tenantId }), sessionCookieOptions());
      }
      response.cookies.set(COOKIES.tenant, "", sessionCookieOptions(0));
      return response;
    }
    await apiFetch("/security/admin-mode/deactivate", { method: "POST", body: {}, headers: { "X-Tenant-Id": "" } });
    const response = NextResponse.json({ active: false }, { headers: noStore });
    let tenant = "";
    try {
      const saved = JSON.parse(req.cookies.get(COOKIES.customerTenant)?.value ?? "{}");
      if (saved.sub === auth.userId && !!auth.sessionId && saved.sid === auth.sessionId && typeof saved.tenant === "string" && UUID_RE.test(saved.tenant)) tenant = saved.tenant;
    } catch { /* An invalid selection is discarded, never authorized. */ }
    response.cookies.set(COOKIES.adminMode, "", sessionCookieOptions(0));
    response.cookies.set(COOKIES.customerTenant, "", sessionCookieOptions(0));
    response.cookies.set(COOKIES.tenant, tenant, sessionCookieOptions(tenant ? undefined : 0));
    return response;
  } catch (error) { return failure(error); }
}