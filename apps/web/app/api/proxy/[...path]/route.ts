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

  const hasBody = req.method !== "GET" && req.method !== "DELETE";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body: await req.text() } : {}),
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return NextResponse.json({ error: { code: "UPSTREAM_UNREACHABLE", message: `API injoignable (${config.apiUrl()})` } }, { status: 502 });
  }
  const res = new NextResponse(upstream.status === 204 ? null : upstream.body, { status: upstream.status });
  const ct = upstream.headers.get("content-type");
  if (ct) res.headers.set("content-type", ct);
  const cd = upstream.headers.get("content-disposition");
  if (cd) res.headers.set("content-disposition", cd);
  res.headers.set("cache-control", "no-store");
  return res;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
