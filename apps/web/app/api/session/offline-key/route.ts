// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Matériau de clé pour le chiffrement des brouillons hors ligne.
 *
 * HMAC-SHA256(secret serveur, mode:userId:tenantId) : lié à la session (un
 * autre utilisateur ou un autre dossier obtient un matériau différent), jamais
 * stocké côté client — le navigateur en dérive une clé AES-GCM non extractable
 * qu'il conserve dans IndexedDB, puis oublie le matériau.
 */
import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { config } from "@/lib/config";

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Session absente" } }, { status: 401 });
  const secret = config.authSecret() ?? (config.authMode() === "dev" ? "arcompt-dev-secret-change-me" : null);
  if (!secret) return NextResponse.json({ error: { code: "CONFIG", message: "AUTH_SECRET ou SESSION_SECRET manquant" } }, { status: 500 });
  const material = createHmac("sha256", secret).update(`${auth.mode}:${auth.userId}:${auth.tenantId ?? ""}`).digest("base64");
  const res = NextResponse.json({ material });
  res.headers.set("cache-control", "no-store");
  return res;
}
