// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Proxy authentifié vers l'API : le navigateur appelle /api/proxy/<chemin>,
 * le serveur Next ajoute les en-têtes d'authentification (Bearer ou X-*) et
 * relaie la réponse telle quelle. Le jeton ne quitte jamais le serveur.
 * Aucun en-tête X-Tenant-Id envoyé par le navigateur n'est relayé : le dossier
 * vient du cookie de session, pas du client.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { config } from "@/lib/config";
import { acceptsMutationOrigin } from "@/lib/proxy-origin";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!ALLOWED_METHODS.has(req.method)) return NextResponse.json({ error: { code: "METHOD", message: "Méthode non permise" } }, { status: 405 });
  if (req.method !== "GET" && !acceptsMutationOrigin(req)) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Origine non autorisée" } }, { status: 403 });
  }
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Session absente" } }, { status: 401 });
  const { path } = await ctx.params;
  if (path.some((part) => part === "." || part === ".." || /[/%\\]/.test(part))) {
    return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }
  // MFA proofs must only flow through /api/session/mfa, which replaces them
  // with an httpOnly cookie. The generic proxy must never expose raw proofs.
  if (path[0] === "security" && (path[1] === "mfa" || path[1] === "admin-mode")) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Utilisez /api/session/mfa" } }, { status: 404 });
  }
  const target = new URL(`/v1/${path.map(encodeURIComponent).join("/")}`, config.apiUrl());
  target.search = req.nextUrl.search;

  const headers: Record<string, string> = { accept: "application/json", ...auth.headers };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  // Le corps est relayé en flux, tel quel (octets), avec son content-type :
  // indispensable pour les envois multipart (pièces, photos) que `req.text()`
  // corromprait. `duplex: "half"` est exigé par undici pour un corps en flux.
  const hasBody = req.method !== "GET" && req.method !== "DELETE" && req.body !== null;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      cache: "no-store",
      redirect: "manual",
    } as RequestInit);
  } catch {
    return NextResponse.json({ error: { code: "UPSTREAM_UNREACHABLE", message: `API injoignable (${config.apiUrl()})` } }, { status: 502 });
  }
  const res = new NextResponse(upstream.status === 204 ? null : upstream.body, { status: upstream.status });
  const ct = upstream.headers.get("content-type");
  if (ct) res.headers.set("content-type", ct);
  const cd = upstream.headers.get("content-disposition");
  if (cd) res.headers.set("content-disposition", cd);
  // Marque des documents produits depuis un pack non publié : elle doit
  // traverser le proxy, sans quoi un fichier téléchargé par l'application perd
  // ce que l'API avait pris soin de dire.
  const official = upstream.headers.get("x-arcompt-official");
  if (official) res.headers.set("x-arcompt-official", official);
  res.headers.set("cache-control", "no-store");
  return res;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
