// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import { maskSensitive, PayrollError, PayrollService, type Employee, type EmployeeInput, type EmployeePatch, type PayslipInputs, type PayslipView } from "@arcompt/payroll";
import { requireRole, type AuthContext, type Role } from "../auth.js";
import type { AppDeps } from "../app.js";
import { entitlementsForAuth, upgradeRequiredBody } from "../entitlements.js";

/**
 * Routes du module paie. Le dossier vient du jeton (auth.tenantId) : un OWNER
 * ne voit que la paie de son propre dossier, comme tout autre rôle. Les
 * champs sensibles (salaire, RIB, numéro de sécurité sociale) ne sont rendus
 * en clair qu'aux rôles OWNER et ACCOUNTANT ; CASHIER, AUDITOR et REVIEWER
 * les reçoivent masqués. Sans base (deps.db absent), le module répond 503.
 */
const FULL_ACCESS: Role[] = ["OWNER", "ACCOUNTANT"];

const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "montant décimal attendu");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

const AllowanceSchema = z.object({ code: z.string().min(1).max(40), label: z.string().min(1).max(120), amount: decimal, taxable: z.boolean().optional() });
const BankDetailsSchema = z.object({ bank: z.string().max(120).optional(), iban: z.string().max(40).optional(), rib: z.string().max(40).optional(), mobileMoney: z.string().max(30).optional() });

export const EmployeeInputSchema = z.object({
  matricule: z.string().min(1).max(30),
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  hireDate: isoDate,
  leaveDate: isoDate.optional(),
  contractType: z.enum(["CDI", "CDD", "STAGE", "JOURNALIER", "AUTRE"]).optional(),
  category: z.string().max(60).optional(),
  baseSalary: decimal,
  allowances: z.array(AllowanceSchema).optional(),
  bankDetails: BankDetailsSchema.optional(),
  socialSecurityNumber: z.string().max(40).optional(),
  taxId: z.string().max(40).optional(),
  dependants: z.number().int().min(0).max(30).optional(),
});
export const EmployeePatchSchema = EmployeeInputSchema.partial().extend({ active: z.boolean().optional() });

const PayslipInputsSchema = z.object({
  overtime: decimal.optional(),
  bonuses: z.array(z.object({ label: z.string().min(1).max(120), amount: decimal })).optional(),
  deductions: z.array(z.object({ label: z.string().min(1).max(120), amount: decimal })).optional(),
  advance: decimal.optional(),
  variables: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), decimal).optional(),
});
const PeriodSchema = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });

export function payrollRoutes(deps: AppDeps) {
  const r = new Hono();

  r.use("*", async (c, next) => {
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Module paie indisponible : aucune base de données configurée" } }, 503);
    // Droit fonctionnel : la paie n'existe que dans les offres qui l'incluent.
    const auth = c.get("auth") as AuthContext;
    const ent = await entitlementsForAuth(deps.db, auth).catch(() => null);
    if (ent && !ent.features.payroll) {
      return c.json(upgradeRequiredBody(ent, "payroll", "La paie", "Pro"), 403);
    }
    return next();
  });

  const service = (auth: AuthContext) =>
    new PayrollService({
      db: deps.db!,
      ledger: deps.ledgerFor(auth),
      actor: { userId: auth.userId, tenantId: auth.tenantId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) },
    });
  const sees = (auth: AuthContext) => auth.roles.some((role) => FULL_ACCESS.includes(role as Role));
  const employeeOut = (auth: AuthContext) => (e: Employee) => (sees(auth) ? e : maskEmployee(e));
  const invalid = (c: Context, issues: unknown) => c.json({ error: { code: "VALIDATION", message: "Requête invalide", details: issues } }, 400);

  // --- Salariés ---------------------------------------------------------------
  r.get("/employees", (c) =>
    handle(c, async () => {
      const auth = c.get("auth");
      const q = z.object({ active: z.enum(["true", "false"]).optional() }).safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const list = await service(auth).listEmployees(q.data.active === undefined ? {} : { active: q.data.active === "true" });
      return c.json(list.map(employeeOut(auth)));
    }),
  );

  r.post("/employees", requireRole("OWNER", "ACCOUNTANT"), (c) =>
    handle(c, async () => {
      const parsed = EmployeeInputSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const auth = c.get("auth");
      // strip() retire les clés undefined ; le type zod garde des `| undefined` qu'EmployeeInput n'admet pas.
      return c.json(await service(auth).createEmployee(strip(parsed.data) as unknown as EmployeeInput), 201);
    }),
  );

  r.get("/employees/:id", (c) =>
    handle(c, async () => {
      const auth = c.get("auth");
      return c.json(employeeOut(auth)(await service(auth).getEmployee(c.req.param("id"))));
    }),
  );

  r.patch("/employees/:id", requireRole("OWNER", "ACCOUNTANT"), (c) =>
    handle(c, async () => {
      const parsed = EmployeePatchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).updateEmployee(c.req.param("id"), strip(parsed.data) as unknown as EmployeePatch));
    }),
  );

  /** Sortie du salarié : désactivation, jamais de suppression (les bulletins passés y renvoient). */
  r.delete("/employees/:id", requireRole("OWNER", "ACCOUNTANT"), (c) =>
    handle(c, async () => {
      const q = z.object({ leaveDate: isoDate.optional() }).safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const auth = c.get("auth");
      await service(auth).deactivateEmployee(c.req.param("id"), q.data.leaveDate);
      return c.body(null, 204);
    }),
  );

  // --- Cycles de paie ---------------------------------------------------------
  r.get("/runs", (c) =>
    handle(c, async () => {
      const q = z.object({ year: z.coerce.number().int().optional() }).safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).listRuns(q.data.year === undefined ? {} : { year: q.data.year }));
    }),
  );

  r.post("/runs", requireRole("OWNER", "ACCOUNTANT"), (c) =>
    handle(c, async () => {
      const parsed = PeriodSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).createRun(parsed.data.year, parsed.data.month), 201);
    }),
  );

  r.get("/runs/:id", (c) =>
    handle(c, async () => {
      const auth = c.get("auth");
      return c.json(await service(auth).getRun(c.req.param("id")));
    }),
  );

  /** Corps : { inputs?: { [employeeId]: { overtime?, bonuses?, deductions?, advance?, variables? } } }. */
  r.post("/runs/:id/compute", requireRole("OWNER", "ACCOUNTANT"), (c) =>
    handle(c, async () => {
      const parsed = z.object({ inputs: z.record(uuid, PayslipInputsSchema).optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const auth = c.get("auth");
      const inputs = Object.fromEntries(Object.entries(parsed.data.inputs ?? {}).map(([k, v]) => [k, strip(v) as PayslipInputs]));
      return c.json(await service(auth).computeRun(c.req.param("id"), inputs));
    }),
  );

  r.post("/runs/:id/validate", requireRole("OWNER", "ACCOUNTANT"), (c) =>
    handle(c, async () => {
      const parsed = z.object({ date: isoDate.optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).validateRun(c.req.param("id"), parsed.data.date ? { date: parsed.data.date } : {}));
    }),
  );

  /** Corps : { treasuryAccountNumber: "521" | "571" | "5381"…, date }. */
  r.post("/runs/:id/pay", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), (c) =>
    handle(c, async () => {
      const parsed = z.object({ treasuryAccountNumber: z.string().regex(/^5\d{1,12}$/), date: isoDate }).safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).payRun(c.req.param("id"), parsed.data.treasuryAccountNumber, parsed.data.date));
    }),
  );

  r.get("/runs/:id/payslips", (c) =>
    handle(c, async () => {
      const auth = c.get("auth");
      return c.json(await service(auth).listPayslips(c.req.param("id")));
    }),
  );

  // --- Bulletins, livre de paie, déclarations ----------------------------------
  r.get("/payslips/:id", (c) =>
    handle(c, async () => {
      const auth = c.get("auth");
      const view = await service(auth).payslipView(c.req.param("id"));
      return c.json(sees(auth) ? view : maskView(view));
    }),
  );

  r.get("/book", requireRole("OWNER", "ACCOUNTANT", "AUDITOR", "REVIEWER"), (c) =>
    handle(c, async () => {
      const q = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).payrollBook(q.data.year));
    }),
  );

  r.get("/declarations", requireRole("OWNER", "ACCOUNTANT", "AUDITOR", "REVIEWER"), (c) =>
    handle(c, async () => {
      const q = PeriodSchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).declarations(q.data));
    }),
  );

  r.post("/declarations/:id/file", requireRole("OWNER", "ACCOUNTANT"), (c) =>
    handle(c, async () => {
      const parsed = z.object({ filingReference: z.string().min(1).max(120) }).safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const auth = c.get("auth");
      return c.json(await service(auth).fileDeclaration(c.req.param("id"), parsed.data.filingReference));
    }),
  );

  return r;
}

/** Les erreurs métier de la paie deviennent des réponses 400/404/409/422 ; le reste remonte à app.onError. */
async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PayrollError) return c.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, e.status);
    throw e;
  }
}

function maskEmployee(e: Employee): Employee {
  return {
    ...e,
    baseSalary: "***",
    bankDetails: e.bankDetails
      ? {
          ...(e.bankDetails.bank ? { bank: e.bankDetails.bank } : {}),
          ...(e.bankDetails.iban ? { iban: maskSensitive(e.bankDetails.iban, 4)! } : {}),
          ...(e.bankDetails.rib ? { rib: maskSensitive(e.bankDetails.rib, 4)! } : {}),
          ...(e.bankDetails.mobileMoney ? { mobileMoney: maskSensitive(e.bankDetails.mobileMoney, 2)! } : {}),
        }
      : null,
    socialSecurityNumber: maskSensitive(e.socialSecurityNumber, 3),
  };
}

function maskView(v: PayslipView): PayslipView {
  const masked = maskEmployee({ bankDetails: v.employee.bankDetails, socialSecurityNumber: v.employee.socialSecurityNumber, baseSalary: "" } as Employee);
  return { ...v, employee: { ...v.employee, socialSecurityNumber: masked.socialSecurityNumber, bankDetails: masked.bankDetails } };
}

/** Retire les clés `undefined` que zod laisse sur les champs optionnels (exactOptionalPropertyTypes). */
function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
