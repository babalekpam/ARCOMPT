// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/** Lit les identifiants du dossier de démonstration et les expose aux tests. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL requis pour les tests de bout en bout");
  const sql = postgres(url, { max: 1 });
  try {
    const [company] = await sql`SELECT id, organization_id FROM company ORDER BY created_at LIMIT 1`;
    const [user] = await sql`SELECT id FROM app_user WHERE organization_id = ${company!.organization_id} ORDER BY created_at LIMIT 1`;
    const ctx = { tenantId: company!.id as string, organizationId: company!.organization_id as string, userId: user!.id as string };
    writeFileSync(join(__dirname, ".context.json"), JSON.stringify(ctx));
  } finally {
    await sql.end();
  }
}
