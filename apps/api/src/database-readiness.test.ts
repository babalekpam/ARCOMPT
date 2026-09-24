// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { databaseSecurityProblems, type DatabaseSecuritySnapshot } from "./database-readiness.js";

function safeSnapshot(): DatabaseSecuritySnapshot {
  const names = ["onboarding_bootstrap", "platform_admin", "platform_admin_audit", "background_job", "background_job_review"];
  const policies = ["onboarding_bootstrap_access", "platform_admin_internal", "platform_admin_audit_internal", "tenant_isolation", "tenant_isolation"];
  return {
    role: { name: "arcompt_app_login", rolsuper: false, rolbypassrls: false },
    tables: names.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true, owned_by_app: false })),
    policies: [...names.map((tablename, i) => {
      const expression = policies[i] === "tenant_isolation"
        ? "(tenant_id = app_tenant_id())"
        : tablename === "onboarding_bootstrap"
        ? "(clerk_sub = current_setting('app.clerk_sub'::text, true))"
        : `(CURRENT_USER = ( SELECT r.rolname FROM (pg_class c JOIN pg_roles r ON ((r.oid = c.relowner))) WHERE (c.oid = ('${tablename}'::regclass)::oid)))`;
      return { tablename, policyname: policies[i]!, cmd: "ALL", qual: expression, with_check: expression };
    }), ...names.slice(3).map((tablename) => {
      const expression = `(CURRENT_USER = ( SELECT r.rolname FROM (pg_class c JOIN pg_roles r ON ((r.oid = c.relowner))) WHERE (c.oid = ('${tablename}'::regclass)::oid)))`;
      return { tablename, policyname: `${tablename}_owner`, cmd: "ALL", qual: expression, with_check: expression };
    })],
    functions: [
      "public.auth_bootstrap_lookup(text,text)",
      "public.auth_bootstrap_replay(text)",
      "public.platform_admin_identity(text)",
      "public.platform_admin_company(text,uuid)",
      "public.platform_admin_companies(text)",
      "public.platform_admin_record_access(text,uuid,text,text)",
      "public.background_job_retry_internal(uuid)",
      "public.background_job_review_reminder(uuid,uuid,text)",
      "public.background_job_claim(text[])",
      "public.background_job_renew(uuid,uuid)",
      "public.background_job_finish(uuid,uuid,text)",
      "public.background_job_expire_reminders()",
      "public.auth_resolve_identity(text)",
      "public.auth_link_subject(text,text)",
      "public.auth_touch_last_active(uuid)",
      "public.organization_of_company(uuid)",
      "public.portal_dashboard(uuid)",
      "public.invitation_by_token_hash(text)",
      "public.whatsapp_resolve_phone(text)",
      "public.payment_link_resolve(text,text)",
    ].map((signature) => ({
      signature, exists: true, security_definer: true,
      executable: !["background_job_claim", "background_job_renew", "background_job_finish", "background_job_expire_reminders"]
        .some((name) => signature.includes(name)),
      owner: "neondb_owner", managed_owner: "neondb_owner",
      proconfig: ["search_path=pg_catalog, public, pg_temp"],
      public_execute: false, app_execute: !signature.includes("background_job_claim") &&
        !signature.includes("background_job_renew") && !signature.includes("background_job_finish") &&
        !signature.includes("background_job_expire_reminders"),
      queue_execute: signature.includes("background_job_claim") || signature.includes("background_job_renew") ||
        signature.includes("background_job_finish") || signature.includes("background_job_expire_reminders"),
    })),
  };
}

describe("production database readiness", () => {
  it("accepts a complete RLS and onboarding baseline", () => {
    expect(databaseSecurityProblems(safeSnapshot())).toEqual([]);
  });

  it("refuses the incomplete policies and missing functions produced by Publish", () => {
    const snapshot = safeSnapshot();
    snapshot.tables[0]!.relforcerowsecurity = false;
    snapshot.policies[0]!.qual = null;
    snapshot.policies[0]!.with_check = null;
    snapshot.functions[0]!.exists = false;
    const problems = databaseSecurityProblems(snapshot).join("\n");
    expect(problems).toContain("RLS non activée et forcée sur onboarding_bootstrap");
    expect(problems).toContain("politique RLS sans condition");
    expect(problems).toContain("fonction sécurisée indisponible");
  });

  it("refuses a privileged application login and missing required table", () => {
    const snapshot = safeSnapshot();
    snapshot.role.rolbypassrls = true;
    snapshot.tables.shift();
    expect(databaseSecurityProblems(snapshot).join("\n")).toMatch(/contourne les politiques RLS.*\ntable onboarding_bootstrap absente/);
  });

  it("rejects a policy that exists but grants unrestricted access", () => {
    const snapshot = safeSnapshot();
    snapshot.policies[0]!.qual = "true";
    snapshot.policies[0]!.with_check = "true";
    expect(databaseSecurityProblems(snapshot).join("\n")).toContain("politique requise différente");
  });

  it("refuses a missing 0028 SECURITY DEFINER function", () => {
    const snapshot = safeSnapshot();
    snapshot.functions.find((fn) => fn.signature === "public.background_job_claim(text[])")!.exists = false;
    expect(databaseSecurityProblems(snapshot).join("\n")).toContain("background_job_claim(text[])");
  });

  it("refuses an old search_path or an owner differing from the managed table owner", () => {
    const snapshot = safeSnapshot();
    const fn = snapshot.functions.find((row) => row.signature === "public.platform_admin_company(text,uuid)")!;
    fn.proconfig = ["search_path=public"];
    // public is commonly owned by pg_database_owner while protected tables
    // and migration-created functions are owned by neondb_owner/postgres.
    fn.owner = "pg_database_owner";
    fn.managed_owner = "neondb_owner";
    const problems = databaseSecurityProblems(snapshot).join("\n");
    expect(problems).toContain("platform_admin_company(text,uuid)");
  });

  it("refuses an app login that cannot execute a required function despite a group grant", () => {
    const snapshot = safeSnapshot();
    snapshot.functions.find((fn) => fn.signature === "public.platform_admin_company(text,uuid)")!.executable = false;
    expect(databaseSecurityProblems(snapshot).join("\n")).toContain("platform_admin_company(text,uuid)");
  });

  it("refuses a database connection that owns protected tables", () => {
    const snapshot = safeSnapshot();
    snapshot.tables[0]!.owned_by_app = true;
    expect(databaseSecurityProblems(snapshot).join("\n")).toContain("peut modifier sa RLS");
  });

  it("rejects Publish's unscoped background-job policies and missing FORCE RLS", () => {
    const snapshot = safeSnapshot();
    snapshot.tables[3]!.relforcerowsecurity = false;
    snapshot.policies.find((p) => p.tablename === "background_job" && p.policyname === "tenant_isolation")!.qual = null;
    snapshot.policies.find((p) => p.tablename === "background_job" && p.policyname === "tenant_isolation")!.with_check = null;
    const problems = databaseSecurityProblems(snapshot).join("\n");
    expect(problems).toContain("RLS non activée et forcée sur background_job");
    expect(problems).toContain("politique requise absente ou incomplète : background_job.tenant_isolation");
  });

  it("rejects a newly added permissive policy even if the tenant policy remains intact", () => {
    const snapshot = safeSnapshot();
    snapshot.policies.push({ tablename: "background_job", policyname: "allow_all", cmd: "ALL", qual: "true", with_check: "true" });
    expect(databaseSecurityProblems(snapshot).join("\n")).toContain("politique RLS autorisant tout : background_job.allow_all");
  });

  it("permits only the read-only global catalogue policy, not an open write policy", () => {
    const snapshot = safeSnapshot();
    snapshot.tables.push({ relname: "subscription_plan", relrowsecurity: true, relforcerowsecurity: true, owned_by_app: false });
    snapshot.policies.push({ tablename: "subscription_plan", policyname: "subscription_plan_read", cmd: "SELECT", qual: "true", with_check: null });
    expect(databaseSecurityProblems(snapshot)).toEqual([]);
    snapshot.policies.at(-1)!.cmd = "ALL";
    expect(databaseSecurityProblems(snapshot).join("\n")).toContain("politique RLS autorisant tout : subscription_plan.subscription_plan_read");
  });
});