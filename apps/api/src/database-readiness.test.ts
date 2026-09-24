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
      return { tablename, policyname: policies[i]!, qual: expression, with_check: expression };
    }), ...names.slice(3).map((tablename) => {
      const expression = `(CURRENT_USER = ( SELECT r.rolname FROM (pg_class c JOIN pg_roles r ON ((r.oid = c.relowner))) WHERE (c.oid = ('${tablename}'::regclass)::oid)))`;
      return { tablename, policyname: `${tablename}_owner`, qual: expression, with_check: expression };
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
    ].map((signature) => ({ signature, exists: true, security_definer: true, executable: true })),
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
    snapshot.policies.push({ tablename: "background_job", policyname: "allow_all", qual: "true", with_check: "true" });
    expect(databaseSecurityProblems(snapshot).join("\n")).toContain("politique RLS autorisant tout : background_job.allow_all");
  });
});