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

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!ALLOWED_METHODS.has(req.method)) return NextResponse.json({ error: { code: "METHOD", message: "Méthode non permise" } }, { status: 405 });
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Session absente" } }, { status: 401 });
  const { path } = await ctx.params;
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
