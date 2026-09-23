// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { redirect } from "next/navigation";
/**
 * Contexte d'authentification côté serveur Next.
 *
 * - AUTH_MODE=dev : cookie httpOnly `arcompt_dev` (JSON {userId, tenantId, organizationId})
 *   transmis à l'API en X-User-Id / X-Tenant-Id / X-Organization-Id ;
 * - AUTH_MODE=clerk : session Clerk, jeton court transmis en Bearer par le
 *   proxy serveur (jamais exposé au navigateur).
 *
 * Dans les deux cas, le dossier courant peut être changé par le cookie
 * `arcompt_tenant` (sélecteur de dossier). L'API reste seule juge de
 * l'appartenance : le cookie ne fait que choisir parmi les dossiers autorisés.
 */
import { cookies } from "next/headers";
import { COOKIES, config, type AuthMode } from "./config";

export interface DevSession {
  userId: string;
  tenantId: string;
  organizationId?: string;
}

export interface AuthContext {
  mode: AuthMode;
  userId: string;
  tenantId: string | null;
  organizationId: string | null;
  /** En-têtes à joindre à chaque appel API. */
  headers: Record<string, string>;
  /** Nom affiché (OIDC) ou identifiant (dev). */
  displayName: string;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDevCookie(raw: string | undefined): DevSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DevSession>;
    if (typeof parsed.userId !== "string" || !parsed.userId) return null;
    return {
      userId: parsed.userId,
      tenantId: typeof parsed.tenantId === "string" ? parsed.tenantId : "",
      ...(typeof parsed.organizationId === "string" && parsed.organizationId ? { organizationId: parsed.organizationId } : {}),
    };
  } catch {
    return null;
  }
}

/** Construit les en-têtes API à partir d'un contexte (sans dépendre de Next : testable). */
export function buildHeaders(input: { mode: AuthMode; userId?: string; tenantId?: string | null; organizationId?: string | null; accessToken?: string }): Record<string, string> {
  const h: Record<string, string> = {};
  if (input.mode === "dev") {
    if (input.userId) h["X-User-Id"] = input.userId;
  } else if (input.accessToken) {
    h["Authorization"] = `Bearer ${input.accessToken}`;
  }
  if (input.tenantId) h["X-Tenant-Id"] = input.tenantId;
  if (input.organizationId) h["X-Organization-Id"] = input.organizationId;
  return h;
}

/** Contexte courant ou null si non connecté. */
export async function getAuthContext(): Promise<AuthContext | null> {
  const store = await cookies();
  const mode = config.authMode();
  const tenantOverride = store.get(COOKIES.tenant)?.value;

  if (mode === "dev") {
    const dev = parseDevCookie(store.get(COOKIES.dev)?.value);
    if (!dev) return null;
    const tenantId = tenantOverride || dev.tenantId || null;
    const organizationId = dev.organizationId ?? null;
    return {
      mode,
      userId: dev.userId,
      tenantId,
      organizationId,
      headers: buildHeaders({ mode, userId: dev.userId, tenantId, organizationId }),
      displayName: dev.userId,
    };
  }

  const { auth } = await import("@clerk/nextjs/server");
  const session = await auth();
  if (!session.userId) return null;
  const accessToken = await session.getToken();
  if (!accessToken) throw new Error("Clerk est configuré mais n'a fourni aucun jeton de session");
  const tenantId = tenantOverride || null;
  const organizationId = session.orgId ?? null;
  return {
    mode,
    userId: session.userId,
    tenantId,
    organizationId,
    headers: buildHeaders({ mode, tenantId, organizationId, accessToken }),
    displayName: session.userId,
  };
}

/** Contexte obligatoire : lève une erreur (les layouts redirigent avant). */
export async function requireAuthContext(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  return ctx;
}
