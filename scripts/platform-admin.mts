// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { createDb } from "../packages/db/src/client.js";
import { pathToFileURL } from "node:url";

const RESERVED_NAME = "__ARCOMPT_PLATFORM_INTERNAL__";
const arg = (name: string, required = true): string | undefined => {
  const a = process.argv.slice(2);
  const i = a.findIndex((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (i < 0) { if (required) throw new Error(`Argument --${name} requis.`); return undefined; }
  const v = a[i]!.startsWith(`--${name}=`) ? a[i]!.slice(name.length + 3) : a[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`Argument --${name} requis.`);
  return v;
};

export async function clerkVerify(sub: string, email: string): Promise<boolean> {
  const secret = (process.env.ARCOMPT_CLERK_ADMIN_SECRET_KEY ?? process.env.CLERK_SECRET_KEY)?.trim();
  if (!secret) throw new Error("CLERK_SECRET_KEY manquant.");
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(sub)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) throw new Error(`Clerk a refusé la vérification (${response.status}).`);
  const user = await response.json() as {
    id?: string; primary_email_address_id?: string;
    email_addresses?: Array<{ id?: string; email_address?: string; verification?: { status?: string } }>;
    two_factor_enabled?: boolean;
    banned?: boolean; locked?: boolean;
  };
  const primary = user.email_addresses?.find((x) => x.id === user.primary_email_address_id);
  if (user.banned || user.locked || user.id !== sub || primary?.email_address?.toLowerCase() !== email.toLowerCase() ||
      primary.verification?.status !== "verified") {
    throw new Error("Sujet Clerk et email primaire vérifié ne correspondent pas.");
  }
  return user.two_factor_enabled === true;
}

export async function main(): Promise<void> {
  const action = arg("action")!.toLowerCase();
  if (action !== "grant" && action !== "revoke") throw new Error("--action doit être grant ou revoke.");
  const sub = arg("sub")!;
  const email = arg("email", action === "grant");
  const reason = arg("reason")!.trim();
  const operator = arg("operator")!.trim();
  if (!reason || !operator) throw new Error("--reason et --operator ne peuvent pas être vides.");
  if (process.argv.includes("--dual-mode")) {
    await dualMode(action, sub, email, reason, operator);
    return;
  }
  const idpMfa = action === "grant" ? await clerkVerify(sub, email!) : false;

  const db = createDb({ max: 2 });
  try {
    const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    const preview = await db.begin(async (tx) => {
      const [role] = await tx`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      if (!role?.rolsuper && !role?.rolbypassrls) throw new Error("Compte DB privilégié requis (superuser ou BYPASSRLS), jamais arcompt_app.");
      if (action === "revoke") {
        const [binding] = await tx`SELECT user_id FROM platform_admin_binding WHERE clerk_sub=${sub}`;
        if (binding) throw new Error("Identité dual-mode détectée : utilisez --dual-mode pour révoquer le droit et ses sessions.");
      }
      if (action === "grant") {
        const [factor] = await tx`SELECT enabled_at FROM app_mfa_factor WHERE clerk_sub = ${sub}`;
        if (!idpMfa && !factor?.enabled_at) throw new Error("MFA obligatoire : activez et confirmez un authentificateur ARCOMPT ou Clerk avant la promotion.");
      }
      await tx`SELECT pg_advisory_xact_lock(19021, 18)`;
      const [reserved] = await tx`SELECT r.organization_id FROM platform_admin_reserved_org r FOR UPDATE`;
      if (reserved && (await tx`SELECT 1 FROM company WHERE organization_id = ${reserved.organization_id} LIMIT 1`).length) {
        throw new Error("L'organisation interne réservée ne doit contenir aucun dossier.");
      }
      const users = await tx`SELECT u.id, u.email, u.organization_id,
        EXISTS (SELECT 1 FROM platform_admin_reserved_org r WHERE r.organization_id = u.organization_id) AS internal
        FROM app_user u WHERE u.keycloak_sub = ${sub}`;
      const target = users.find((u) => u.internal);
      if (action === "grant" && users.some((u) => !u.internal)) throw new Error("Sujet déjà lié à un app_user tenant; refus de promotion.");
      if (action === "grant" && target && String(target.email).toLowerCase() !== email!.toLowerCase()) throw new Error("Email du app_user interne différent.");
      const current = target ? await tx`SELECT active FROM platform_admin WHERE user_id = ${target.id}` : [];
      return { reserved: reserved?.organization_id as string | undefined, target, active: current.length ? Boolean(current[0]!.active) : false };
    });
    console.log(`Base : ${database}`);
    console.log(`${action === "grant" ? "Accorder" : "Révoquer"} platform admin pour ${sub}`);
    if (action === "grant") console.log(`Email vérifié : ${email}`);
    console.log(`Motif : ${reason} · Opérateur : ${operator}`);
    if (action === "revoke" && !preview.target) { console.log("Aucun changement (sujet inconnu)."); return; }
    if (action === "revoke" && preview.target && !preview.target.internal) throw new Error("Le sujet n'est pas un administrateur interne.");
    if (action === "grant" && preview.active) { console.log("Aucun changement."); return; }
    if (!process.argv.includes("--apply")) { console.log("Aucun changement (aperçu)."); return; }
    if (arg("confirm-db") !== database) throw new Error(`Confirmez explicitement la base avec --confirm-db ${database}.`);
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(19021, 18)`;
      const [role] = await tx`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      if (!role?.rolsuper && !role?.rolbypassrls) throw new Error("Compte DB privilégié requis.");
      // The preview is informational, never authorization state. Prevent a
      // concurrent onboarding/link operation from racing the final checks.
      await tx`LOCK TABLE app_user, company IN SHARE ROW EXCLUSIVE MODE`;
      const [reserved] = await tx`SELECT organization_id FROM platform_admin_reserved_org FOR UPDATE`;
      if (reserved && (await tx`SELECT 1 FROM company WHERE organization_id = ${reserved.organization_id} LIMIT 1`).length) {
        throw new Error("L'organisation interne réservée ne doit contenir aucun dossier.");
      }
      const users = await tx`SELECT u.id, u.email, u.suspended_at,
        EXISTS (SELECT 1 FROM platform_admin_reserved_org r WHERE r.organization_id = u.organization_id) AS internal
        FROM app_user u WHERE u.keycloak_sub = ${sub}`;
      const target = users.find((u) => u.internal);
      if (action === "grant") {
        const currentIdpMfa = await clerkVerify(sub, email!);
        const [factor] = await tx`SELECT enabled_at FROM app_mfa_factor WHERE clerk_sub = ${sub} FOR UPDATE`;
        if (!currentIdpMfa && !factor?.enabled_at) throw new Error("MFA obligatoire.");
        if (users.some((u) => !u.internal)) throw new Error("Sujet lié à un tenant; refus de promotion.");
        if (target && (target.suspended_at || String(target.email).toLowerCase() !== email!.toLowerCase())) {
          throw new Error("Identité interne suspendue ou email différent.");
        }
      }
      if (action === "revoke" && !target) throw new Error("Identité interne introuvable; révocation refusée.");
      let orgId = reserved?.organization_id as string | undefined;
      if (!orgId) {
        const [org] = await tx`INSERT INTO organization(name, kind, plan) VALUES (${RESERVED_NAME}, 'GROUP', 'TRIAL') RETURNING id`;
        orgId = String(org!.id);
        await tx`INSERT INTO platform_admin_reserved_org(organization_id) VALUES (${orgId})`;
      }
      if (action === "grant") {
        let userId = target?.id as string | undefined;
        if (!userId) {
          const [u] = await tx`INSERT INTO app_user(organization_id, keycloak_sub, email, display_name)
            VALUES (${orgId}, ${sub}, ${email!}, ${operator}) RETURNING id`;
          userId = String(u!.id);
        }
        await tx`INSERT INTO platform_admin(user_id, active) VALUES (${userId}, true)
          ON CONFLICT (user_id) DO UPDATE SET active = true`;
        await tx`INSERT INTO platform_admin_audit(actor_user_id, subject_user_id, organization_id, method, path, event, reason, operator_label, database_role)
          VALUES (NULL, ${userId}, ${orgId}, 'CLI', '/platform-admin', 'GRANT', ${reason}, ${operator}, current_user)`;
      } else {
        const userId = String(target!.id);
        await tx`UPDATE platform_admin SET active = false WHERE user_id = ${userId}`;
        await tx`INSERT INTO platform_admin_audit(actor_user_id, subject_user_id, organization_id, method, path, event, reason, operator_label, database_role)
          VALUES (NULL, ${userId}, ${orgId}, 'CLI', '/platform-admin', 'REVOKE', ${reason}, ${operator}, current_user)`;
      }
    });
    console.log("Modification appliquée.");
  } finally { await db.end(); }
}

/** Explicitly opt-in provisioning; never relocates the customer app_user. */
async function dualMode(action: string, sub: string, email: string | undefined, reason: string, operator: string) {
  const apply = process.argv.includes("--apply");
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (apply && arg("confirm-db") !== database) throw new Error("Confirmez explicitement la base cible.");
  if (action === "grant") await clerkVerify(sub, email!);
  const db = createDb({ max: 2 });
  try {
    await db.begin(async (tx) => {
      const [role] = await tx`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      if (!role?.rolsuper && !role?.rolbypassrls) throw new Error("Compte DB privilégié requis.");
      await tx`SELECT pg_advisory_xact_lock(19021,18)`;
      await tx`LOCK TABLE app_user,company IN SHARE ROW EXCLUSIVE MODE`;
      const [reserved] = await tx`SELECT organization_id FROM platform_admin_reserved_org FOR UPDATE`;
      let org = reserved?.organization_id as string | undefined;
      if (org && (await tx`SELECT 1 FROM company WHERE organization_id=${org}`).length) throw new Error("Organisation interne non vide.");
      const [bound] = await tx`SELECT b.user_id,u.organization_id,u.keycloak_sub,u.suspended_at,u.email
        FROM platform_admin_binding b JOIN app_user u ON u.id=b.user_id WHERE b.clerk_sub=${sub} FOR UPDATE OF b,u`;
      if (bound && (bound.organization_id !== org || bound.keycloak_sub !== null)) throw new Error("Identité interne incohérente.");
      if (action === "grant") {
        await clerkVerify(sub, email!);
        const [factor] = await tx`SELECT enabled_at FROM app_mfa_factor WHERE clerk_sub=${sub} FOR UPDATE`;
        if (!factor?.enabled_at) throw new Error("MFA ARCOMPT confirmée obligatoire pour le mode administrateur.");
        const [customer] = await tx`SELECT u.id FROM app_user u WHERE keycloak_sub=${sub}
          AND NOT EXISTS(SELECT 1 FROM platform_admin_reserved_org r WHERE r.organization_id=u.organization_id)`;
        if (!customer) throw new Error("Identité client existante requise pour --dual-mode.");
        if (bound && (bound.suspended_at || String(bound.email).toLowerCase() !== email!.toLowerCase())) throw new Error("Identité interne suspendue ou email différent.");
      }
      console.log(`Base : ${database} · ${action} dual-mode · ${sub} · ${operator} · ${reason}`);
      if (!apply) { console.log("Aucun changement (aperçu)."); return; }
      if (action === "revoke" && !bound) { console.log("Aucun changement (sujet inconnu)."); return; }
      if (!org) {
        const [row] = await tx`INSERT INTO organization(name,kind,plan) VALUES(${RESERVED_NAME},'GROUP','TRIAL') RETURNING id`;
        org = String(row!.id);
        await tx`INSERT INTO platform_admin_reserved_org(organization_id) VALUES(${org})`;
      }
      let user = bound?.user_id as string | undefined;
      if (!user) {
        const [row] = await tx`INSERT INTO app_user(organization_id,keycloak_sub,email,display_name)
          VALUES(${org},NULL,${email!},${operator}) RETURNING id`;
        user = String(row!.id);
        await tx`INSERT INTO platform_admin(user_id,active) VALUES(${user},true)`;
        await tx`INSERT INTO platform_admin_binding(clerk_sub,user_id) VALUES(${sub},${user})`;
      }
      await tx`UPDATE platform_admin SET active=${action === "grant"} WHERE user_id=${user}`;
      // A fresh grant cannot revive a token issued before revocation.
      await tx`DELETE FROM platform_admin_mode WHERE clerk_sub=${sub}`;
      await tx`INSERT INTO platform_admin_audit(subject_user_id,organization_id,method,path,event,reason,operator_label,database_role)
        VALUES(${user},${org},'CLI','/platform-admin/dual-mode',${action === "grant" ? "GRANT" : "REVOKE"},${reason},${operator},current_user)`;
      console.log("Modification appliquée ; identité client inchangée.");
    });
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}