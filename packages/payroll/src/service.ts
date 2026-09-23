import type { Sql } from "postgres";
import {
  assertPackPublished,
  draftPackNotice,
  isPackPublished,
  loadPack as defaultLoadPack,
  PackError,
  PackNotPublishedError,
  packReference,
  type CountryPack,
  type OfficialUse,
} from "@arcompt/country-packs";
import {
  decryptTaxId,
  decryptTaxIds,
  encryptTaxId,
  existingTenantCipherIn,
  PARTNER_TAX_ID_DOMAIN,
  taxIdBlindIndex,
  withTenant,
} from "@arcompt/db";
import { CURRENCY_DECIMALS, Money, sum, type JournalLineInput, type Ledger } from "@arcompt/ledger";
import { computePayslip, firstDayOfMonth, lastDayOfMonth, periodLabel } from "./compute.js";
import { PayrollCrypto, UnknownKeyVersionError, type TenantCipher, type TenantKeyRecord } from "./crypto.js";
import { PayrollError } from "./errors.js";
import { derivePayrollScheme, type PayrollAccounts, type PayrollScheme } from "./scheme.js";
import type {
  Allowance,
  BankDetails,
  Employee,
  EmployeeInput,
  EmployeePatch,
  Id,
  PayrollBook,
  PayrollBookRow,
  PayrollDeclaration,
  PayrollPeriod,
  PayrollRun,
  Payslip,
  PayslipInputs,
  PayslipLine,
  PayslipView,
} from "./types.js";

export interface PayrollActor {
  userId: Id;
  tenantId: Id;
  organizationId?: Id;
}

export interface PayrollServiceOptions {
  db: Sql;
  ledger: Ledger;
  actor: PayrollActor;
  /** Pack pays ; sinon chargé depuis company.country_code. */
  pack?: CountryPack;
  /** Environnement lu par la garde des documents légaux (ALLOW_INSECURE_DRAFT_PACK_FILINGS) ; `process.env` par défaut. */
  env?: Record<string, string | undefined>;
  loadPack?: (code: string) => CountryPack;
  crypto?: PayrollCrypto;
  /** Surcharge des comptes d'imputation (sous-comptes du dossier). */
  accounts?: Partial<PayrollAccounts>;
  contributionAccounts?: Record<string, string>;
  now?: () => Date;
}

interface CompanyInfo {
  id: Id;
  name: string;
  countryCode: string;
  currency: string;
  taxIds: Record<string, string>;
}

const MONEY_TOTALS = ["gross", "employeeContributions", "employerContributions", "incomeTax", "net", "employerCost"] as const;

/**
 * Service de paie d'un dossier : salariés (chiffrés au repos), cycles mensuels,
 * bulletins calculés par le pack pays, écritures via Ledger.post, livre de
 * paie et déclarations. Toute requête passe par withTenant (RLS).
 */
export class PayrollService {
  private readonly db: Sql;
  private readonly ledger: Ledger;
  private readonly actor: PayrollActor;
  private readonly crypto: PayrollCrypto;
  private readonly now: () => Date;
  private readonly opts: PayrollServiceOptions;
  private packCache: CountryPack | undefined;
  private schemeCache: PayrollScheme | undefined;
  private companyCache: CompanyInfo | undefined;
  private cipherCache: TenantCipher | undefined;

  constructor(opts: PayrollServiceOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.ledger = opts.ledger;
    this.actor = opts.actor;
    this.crypto = opts.crypto ?? new PayrollCrypto();
    this.now = opts.now ?? (() => new Date());
    this.packCache = opts.pack;
  }

  // ---------------------------------------------------------------------------
  // Contexte
  // ---------------------------------------------------------------------------
  private tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    const ctx = { tenantId: this.actor.tenantId, userId: this.actor.userId, ...(this.actor.organizationId ? { organizationId: this.actor.organizationId } : {}) };
    return withTenant(this.db, ctx, fn);
  }

  async company(): Promise<CompanyInfo> {
    if (this.companyCache) return this.companyCache;
    const info = await this.tx(async (tx) => {
      const rows = await tx`SELECT id, name, country_code, currency, tax_ids, tax_ids_enc FROM company WHERE id = ${this.actor.tenantId}`;
      const r = rows[0];
      if (!r) throw new PayrollError("PACK_NOT_FOUND", "Dossier introuvable");
      // Lecture : on ne crée pas de clé de données pour un dossier qui n'a
      // encore rien de chiffré.
      const cipher = r.tax_ids_enc ? await existingTenantCipherIn(tx, this.actor.tenantId, this.crypto) : null;
      return {
        id: r.id as string,
        name: r.name as string,
        countryCode: String(r.country_code).toLowerCase(),
        currency: r.currency as string,
        taxIds: decryptTaxIds(cipher, r.tax_ids_enc as string | null, r.tax_ids as Record<string, unknown> | null),
      };
    });
    this.companyCache = info;
    return this.companyCache;
  }

  async pack(): Promise<CountryPack> {
    if (this.packCache) return this.packCache;
    const company = await this.company();
    try {
      this.packCache = (this.opts.loadPack ?? defaultLoadPack)(company.countryCode);
    } catch (e) {
      if (e instanceof PackError || (e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PayrollError("PACK_NOT_FOUND", `Pack pays ${company.countryCode} indisponible : ${(e as Error).message}`);
      }
      throw e;
    }
    return this.packCache;
  }

  async scheme(): Promise<PayrollScheme> {
    if (this.schemeCache) return this.schemeCache;
    this.schemeCache = derivePayrollScheme(await this.pack(), {
      ...(this.opts.accounts ? { accounts: this.opts.accounts } : {}),
      ...(this.opts.contributionAccounts ? { contributionAccounts: this.opts.contributionAccounts } : {}),
    });
    return this.schemeCache;
  }

  /**
   * Garde des documents légaux de la paie.
   *
   * Refusé sur un pack non PUBLISHED : les déclarations sociales et fiscales de
   * la période (CNPS, IPRES, ITS…) et leur dépôt — c'est ce qui part chez
   * l'organisme.
   *
   * Non refusé, mais marqué : le bulletin de paie. C'est à la fois une pièce
   * remise au salarié et une pièce comptable adossée à l'écriture de paie ; le
   * refuser rendrait la paie intestable alors que l'écriture, elle, reste de la
   * tenue ordinaire. `PayslipView.packNotice` porte la mention.
   */
  private async officialFor(artefact: string): Promise<OfficialUse> {
    const pack = await this.pack();
    try {
      return assertPackPublished(pack, { artefact, ...(this.opts.env ? { env: this.opts.env } : {}) });
    } catch (e) {
      if (e instanceof PackNotPublishedError) {
        throw new PayrollError("PACK_NOT_PUBLISHED", e.message, { pack: packReference(pack), status: pack.status, artefact });
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Clés de données du dossier (chiffrement par enveloppe)
  // ---------------------------------------------------------------------------
  private async loadKeys(tx: Sql): Promise<TenantKeyRecord[]> {
    const rows = await tx`SELECT version, wrapped_key, master_key_id, status FROM payroll_tenant_key WHERE tenant_id = ${this.actor.tenantId} ORDER BY version`;
    return rows.map((r) => ({ version: Number(r.version), wrappedKey: r.wrapped_key as string, masterKeyId: r.master_key_id as string, status: r.status as TenantKeyRecord["status"] }));
  }

  /** Jeu de clés du dossier, désenveloppé par le fournisseur de clé maître ; créé à la première utilisation. */
  private async cipher(): Promise<TenantCipher> {
    if (this.cipherCache) return this.cipherCache;
    let records = await this.tx((tx) => this.loadKeys(tx));
    if (records.length === 0) {
      const { record } = await this.crypto.generateTenantKey(1);
      records = await this.tx(async (tx) => {
        // Deux requêtes concurrentes peuvent créer la première clé : l'unicité (tenant, version) tranche, on relit.
        await tx`
          INSERT INTO payroll_tenant_key (tenant_id, version, wrapped_key, master_key_id, status)
          VALUES (${this.actor.tenantId}, ${record.version}, ${record.wrappedKey}, ${record.masterKeyId}, 'ACTIVE')
          ON CONFLICT (tenant_id, version) DO NOTHING`;
        await this.audit(tx, "payroll_key.create", "payroll_tenant_key", String(record.version), { version: record.version, masterKeyId: record.masterKeyId });
        return this.loadKeys(tx);
      });
    }
    this.cipherCache = await this.crypto.cipherFor(records);
    return this.cipherCache;
  }

  /** Jeu de clés pour chiffrer : vérifie que la version active en base est bien celle du cache (rotation faite ailleurs). */
  private async writeCipher(): Promise<TenantCipher> {
    const cipher = await this.cipher();
    const rows = await this.tx((tx) => tx`SELECT max(version)::int AS version FROM payroll_tenant_key WHERE tenant_id = ${this.actor.tenantId} AND status = 'ACTIVE'`);
    const active = rows[0]?.version === null || rows[0]?.version === undefined ? null : Number(rows[0].version);
    if (active === cipher.activeVersion) return cipher;
    this.cipherCache = undefined;
    return this.cipher();
  }

  /** Déchiffre avec le jeu de clés courant ; si un chiffré référence une version inconnue, recharge le jeu et réessaie une fois. */
  private async withCipher<T>(fn: (cipher: TenantCipher) => T): Promise<T> {
    try {
      return fn(await this.cipher());
    } catch (e) {
      if (!(e instanceof UnknownKeyVersionError)) throw e;
      this.cipherCache = undefined;
      return fn(await this.cipher());
    }
  }

  /**
   * Rotation de la clé de données du dossier : nouvelle version ACTIVE, anciennes
   * versions RETIRED (toujours lisibles), re-chiffrement de tous les champs
   * sensibles dans la même transaction.
   */
  async rotateTenantKey(): Promise<{ version: number; previousVersion: number; reencrypted: number }> {
    const current = await this.cipher();
    const previousVersion = current.activeVersion;
    const version = Math.max(...current.versions()) + 1;
    const { record } = await this.crypto.generateTenantKey(version);
    const reencrypted = await this.tx(async (tx) => {
      await tx`UPDATE payroll_tenant_key SET status = 'RETIRED', retired_at = now() WHERE tenant_id = ${this.actor.tenantId} AND status = 'ACTIVE'`;
      await tx`
        INSERT INTO payroll_tenant_key (tenant_id, version, wrapped_key, master_key_id, status)
        VALUES (${this.actor.tenantId}, ${version}, ${record.wrappedKey}, ${record.masterKeyId}, 'ACTIVE')`;
      const next = await this.crypto.cipherFor(await this.loadKeys(tx));
      const re = (v: unknown) => (v ? next.encrypt(current.decrypt(v as string)) : null);
      const rows = await tx`SELECT id, base_salary_enc, bank_details_enc, social_security_number_enc, tax_id_enc FROM employee WHERE tenant_id = ${this.actor.tenantId}`;
      for (const r of rows) {
        await tx`
          UPDATE employee SET base_salary_enc = ${re(r.base_salary_enc)!}, bank_details_enc = ${re(r.bank_details_enc)},
                              social_security_number_enc = ${re(r.social_security_number_enc)}, tax_id_enc = ${re(r.tax_id_enc)}, updated_at = now()
          WHERE tenant_id = ${this.actor.tenantId} AND id = ${r.id as string}`;
      }
      // Les identifiants fiscaux partagent la clé de données du dossier : la
      // rotation les reprend aussi. L'index aveugle, lui, est dérivé de la plus
      // ancienne version de clé — il ne bouge pas et reste valide.
      const partners = await tx`SELECT id, tax_id_enc FROM partner WHERE tenant_id = ${this.actor.tenantId} AND tax_id_enc IS NOT NULL`;
      for (const r of partners) {
        await tx`UPDATE partner SET tax_id_enc = ${re(r.tax_id_enc)} WHERE tenant_id = ${this.actor.tenantId} AND id = ${r.id as string}`;
      }
      const companies = await tx`SELECT id, tax_ids_enc FROM company WHERE id = ${this.actor.tenantId} AND tax_ids_enc IS NOT NULL`;
      for (const r of companies) {
        await tx`UPDATE company SET tax_ids_enc = ${re(r.tax_ids_enc)} WHERE id = ${this.actor.tenantId}`;
      }
      const reencrypted = rows.length + partners.length + companies.length;
      await this.audit(tx, "payroll_key.rotate", "payroll_tenant_key", String(version), { version, previousVersion, reencrypted, masterKeyId: record.masterKeyId });
      this.cipherCache = next;
      this.companyCache = undefined;
      return reencrypted;
    });
    return { version, previousVersion, reencrypted };
  }

  private async audit(tx: Sql, action: string, entity: string, entityId: string, after?: unknown, before?: unknown): Promise<void> {
    await tx`
      INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
      VALUES (${this.actor.tenantId}, ${this.actor.userId}, ${action}, ${entity}, ${entityId},
              ${before === undefined ? null : tx.json(before as never)}, ${after === undefined ? null : tx.json(after as never)}, ${this.now().toISOString()})`;
  }

  // ---------------------------------------------------------------------------
  // Salariés
  // ---------------------------------------------------------------------------
  async createEmployee(input: EmployeeInput): Promise<Employee> {
    validateEmployeeInput(input);
    const scheme = await this.scheme();
    const cipher = await this.writeCipher();
    const id = await this.tx(async (tx) => {
      const dup = await tx`SELECT 1 FROM employee WHERE tenant_id = ${this.actor.tenantId} AND matricule = ${input.matricule}`;
      if (dup.length > 0) throw new PayrollError("MATRICULE_TAKEN", `Matricule ${input.matricule} déjà utilisé`);
      const [partner] = await tx`
        INSERT INTO partner (tenant_id, type, name, tax_id_enc, tax_id_bidx, collective_account)
        VALUES (${this.actor.tenantId}, 'EMPLOYEE', ${fullName(input.lastName, input.firstName)}, ${encryptTaxId(cipher, input.taxId)},
                ${taxIdBlindIndex(cipher, PARTNER_TAX_ID_DOMAIN, input.taxId)}, ${scheme.accounts.netDue})
        RETURNING id`;
      const [row] = await tx`
        INSERT INTO employee (tenant_id, partner_id, matricule, first_name, last_name, hire_date, leave_date, contract_type, category,
                              base_salary_enc, allowances, bank_details_enc, social_security_number_enc, tax_id_enc, dependants)
        VALUES (${this.actor.tenantId}, ${partner!.id as string}, ${input.matricule}, ${input.firstName}, ${input.lastName}, ${input.hireDate},
                ${input.leaveDate ?? null}, ${input.contractType ?? "CDI"}, ${input.category ?? null},
                ${cipher.encrypt(Money.parse(input.baseSalary).toString())}, ${tx.json((input.allowances ?? []) as never)},
                ${input.bankDetails ? cipher.encryptJson(input.bankDetails) : null},
                ${input.socialSecurityNumber ? cipher.encrypt(input.socialSecurityNumber) : null},
                ${encryptTaxId(cipher, input.taxId)}, ${input.dependants ?? 0})
        RETURNING id`;
      const employeeId = row!.id as string;
      await this.audit(tx, "employee.create", "employee", employeeId, { matricule: input.matricule, name: fullName(input.lastName, input.firstName) });
      return employeeId;
    });
    return this.getEmployee(id);
  }

  async getEmployee(id: Id): Promise<Employee> {
    const rows = await this.tx((tx) => tx`${employeeSelect(tx)} WHERE e.tenant_id = ${this.actor.tenantId} AND e.id = ${id}`);
    if (!rows[0]) throw new PayrollError("EMPLOYEE_NOT_FOUND", `Salarié ${id} introuvable`);
    return this.withCipher((cipher) => mapEmployee(rows[0]!, cipher));
  }

  async listEmployees(filter: { active?: boolean } = {}): Promise<Employee[]> {
    const rows = await this.tx((tx) =>
      filter.active === undefined
        ? tx`${employeeSelect(tx)} WHERE e.tenant_id = ${this.actor.tenantId} ORDER BY e.last_name, e.first_name`
        : tx`${employeeSelect(tx)} WHERE e.tenant_id = ${this.actor.tenantId} AND e.active = ${filter.active} ORDER BY e.last_name, e.first_name`,
    );
    if (rows.length === 0) return [];
    return this.withCipher((cipher) => rows.map((r) => mapEmployee(r, cipher)));
  }

  async updateEmployee(id: Id, patch: EmployeePatch): Promise<Employee> {
    const current = await this.getEmployee(id);
    const merged: EmployeeInput & { active: boolean } = {
      matricule: patch.matricule ?? current.matricule,
      firstName: patch.firstName ?? current.firstName,
      lastName: patch.lastName ?? current.lastName,
      hireDate: patch.hireDate ?? current.hireDate,
      ...(patch.leaveDate !== undefined ? { leaveDate: patch.leaveDate } : current.leaveDate ? { leaveDate: current.leaveDate } : {}),
      contractType: patch.contractType ?? current.contractType,
      ...(patch.category !== undefined ? { category: patch.category } : current.category ? { category: current.category } : {}),
      baseSalary: patch.baseSalary ?? current.baseSalary,
      allowances: patch.allowances ?? current.allowances,
      ...(patch.bankDetails !== undefined ? { bankDetails: patch.bankDetails } : current.bankDetails ? { bankDetails: current.bankDetails } : {}),
      ...(patch.socialSecurityNumber !== undefined ? { socialSecurityNumber: patch.socialSecurityNumber } : current.socialSecurityNumber ? { socialSecurityNumber: current.socialSecurityNumber } : {}),
      ...(patch.taxId !== undefined ? { taxId: patch.taxId } : current.taxId ? { taxId: current.taxId } : {}),
      dependants: patch.dependants ?? current.dependants,
      active: patch.active ?? current.active,
    };
    validateEmployeeInput(merged);
    const cipher = await this.writeCipher();
    await this.tx(async (tx) => {
      if (merged.matricule !== current.matricule) {
        const dup = await tx`SELECT 1 FROM employee WHERE tenant_id = ${this.actor.tenantId} AND matricule = ${merged.matricule} AND id <> ${id}`;
        if (dup.length > 0) throw new PayrollError("MATRICULE_TAKEN", `Matricule ${merged.matricule} déjà utilisé`);
      }
      await tx`
        UPDATE employee SET
          matricule = ${merged.matricule}, first_name = ${merged.firstName}, last_name = ${merged.lastName},
          hire_date = ${merged.hireDate}, leave_date = ${merged.leaveDate ?? null}, contract_type = ${merged.contractType ?? "CDI"},
          category = ${merged.category ?? null}, base_salary_enc = ${cipher.encrypt(Money.parse(merged.baseSalary).toString())},
          allowances = ${tx.json((merged.allowances ?? []) as never)},
          bank_details_enc = ${merged.bankDetails ? cipher.encryptJson(merged.bankDetails) : null},
          social_security_number_enc = ${merged.socialSecurityNumber ? cipher.encrypt(merged.socialSecurityNumber) : null},
          tax_id_enc = ${encryptTaxId(cipher, merged.taxId)}, tax_id = NULL,
          dependants = ${merged.dependants ?? 0}, active = ${merged.active}, updated_at = now()
        WHERE tenant_id = ${this.actor.tenantId} AND id = ${id}`;
      await tx`
        UPDATE partner SET name = ${fullName(merged.lastName, merged.firstName)}, tax_id_enc = ${encryptTaxId(cipher, merged.taxId)},
          tax_id_bidx = ${taxIdBlindIndex(cipher, PARTNER_TAX_ID_DOMAIN, merged.taxId)}, tax_id = NULL, active = ${merged.active}
        WHERE tenant_id = ${this.actor.tenantId} AND id = ${current.partnerId}`;
      // La piste d'audit ne contient jamais les champs sensibles.
      await this.audit(tx, "employee.update", "employee", id, publicFields(merged), publicFields(current));
    });
    return this.getEmployee(id);
  }

  /** Sortie du salarié : désactivation (jamais de suppression, les bulletins passés y renvoient). */
  async deactivateEmployee(id: Id, leaveDate?: string): Promise<Employee> {
    return this.updateEmployee(id, { active: false, ...(leaveDate ? { leaveDate } : {}) });
  }

  // ---------------------------------------------------------------------------
  // Cycles de paie
  // ---------------------------------------------------------------------------
  async createRun(year: number, month: number): Promise<PayrollRun> {
    checkPeriod(year, month);
    const scheme = await this.scheme();
    const id = await this.tx(async (tx) => {
      const dup = await tx`SELECT id FROM payroll_run WHERE tenant_id = ${this.actor.tenantId} AND year = ${year} AND month = ${month}`;
      if (dup.length > 0) throw new PayrollError("RUN_EXISTS", `Un cycle de paie existe déjà pour ${periodLabel(year, month)}`, { runId: dup[0]!.id });
      const [row] = await tx`
        INSERT INTO payroll_run (tenant_id, year, month, pack_version, created_by)
        VALUES (${this.actor.tenantId}, ${year}, ${month}, ${scheme.packVersion}, ${this.actor.userId}) RETURNING id`;
      await this.audit(tx, "payroll_run.create", "payroll_run", row!.id as string, { year, month });
      return row!.id as string;
    });
    return this.getRun(id);
  }

  async getRun(id: Id): Promise<PayrollRun> {
    const rows = await this.tx((tx) => tx`SELECT * FROM payroll_run WHERE tenant_id = ${this.actor.tenantId} AND id = ${id}`);
    if (!rows[0]) throw new PayrollError("RUN_NOT_FOUND", `Cycle de paie ${id} introuvable`);
    return mapRun(rows[0]);
  }

  async listRuns(filter: { year?: number } = {}): Promise<PayrollRun[]> {
    const rows = await this.tx((tx) =>
      filter.year === undefined
        ? tx`SELECT * FROM payroll_run WHERE tenant_id = ${this.actor.tenantId} ORDER BY year DESC, month DESC`
        : tx`SELECT * FROM payroll_run WHERE tenant_id = ${this.actor.tenantId} AND year = ${filter.year} ORDER BY month DESC`,
    );
    return rows.map(mapRun);
  }

  /**
   * Calcule les bulletins de tous les salariés actifs sur la période. Les
   * variables du mois sont indexées par identifiant de salarié. Recalculable
   * tant que le cycle n'est pas validé.
   */
  async computeRun(id: Id, inputs: Record<Id, PayslipInputs> = {}): Promise<{ run: PayrollRun; payslips: Payslip[] }> {
    const run = await this.getRun(id);
    if (run.status !== "DRAFT" && run.status !== "COMPUTED") throw new PayrollError("RUN_STATUS", `Cycle ${periodLabel(run.year, run.month)} déjà ${run.status === "PAID" ? "payé" : "validé"}`);
    const pack = await this.pack();
    const scheme = await this.scheme();
    const start = firstDayOfMonth(run.year, run.month);
    const end = lastDayOfMonth(run.year, run.month);
    const employees = (await this.listEmployees({ active: true })).filter((e) => e.hireDate <= end && (e.leaveDate === null || e.leaveDate >= start));
    if (employees.length === 0) throw new PayrollError("RUN_EMPTY", `Aucun salarié actif sur ${periodLabel(run.year, run.month)}`);
    for (const key of Object.keys(inputs)) {
      if (!employees.some((e) => e.id === key)) throw new PayrollError("EMPLOYEE_NOT_FOUND", `Variables de paie pour un salarié inconnu ou inactif : ${key}`);
    }
    const computed = employees.map((e) => {
      try {
        return { employee: e, result: computePayslip(pack, e, { year: run.year, month: run.month }, inputs[e.id] ?? {}, { scheme }) };
      } catch (err) {
        if (err instanceof PayrollError) throw new PayrollError(err.code, `${e.matricule} ${fullName(e.lastName, e.firstName)} : ${err.message}`, { ...err.details, employeeId: e.id });
        throw err;
      }
    });
    const totals = {
      gross: sum(computed.map((c) => c.result.gross)),
      employeeContributions: sum(computed.map((c) => c.result.employeeContributions)),
      employerContributions: sum(computed.map((c) => c.result.employerContributions)),
      incomeTax: sum(computed.map((c) => c.result.incomeTax)),
      net: sum(computed.map((c) => c.result.netToPay)),
      employerCost: sum(computed.map((c) => c.result.employerCost)),
    };
    const at = this.now().toISOString();
    await this.tx(async (tx) => {
      await tx`DELETE FROM payslip WHERE tenant_id = ${this.actor.tenantId} AND run_id = ${id}`;
      for (const { employee, result } of computed) {
        await tx`
          INSERT INTO payslip (tenant_id, run_id, employee_id, currency, gross, taxable_base, employee_contributions, employer_contributions,
                               income_tax, net, advance, net_to_pay, employer_cost, lines, inputs, computed_at)
          VALUES (${this.actor.tenantId}, ${id}, ${employee.id}, ${result.currency}, ${result.gross.toString()}, ${result.taxableBase.toString()},
                  ${result.employeeContributions.toString()}, ${result.employerContributions.toString()}, ${result.incomeTax.toString()},
                  ${result.net.toString()}, ${result.advance.toString()}, ${result.netToPay.toString()}, ${result.employerCost.toString()},
                  ${tx.json(result.lines as never)}, ${tx.json((inputs[employee.id] ?? {}) as never)}, ${at})`;
      }
      await tx`
        UPDATE payroll_run SET status = 'COMPUTED', pack_version = ${scheme.packVersion}, employee_count = ${computed.length},
          total_gross = ${totals.gross.toString()}, total_employee_contributions = ${totals.employeeContributions.toString()},
          total_employer_contributions = ${totals.employerContributions.toString()}, total_income_tax = ${totals.incomeTax.toString()},
          total_net = ${totals.net.toString()}, total_employer_cost = ${totals.employerCost.toString()}, computed_at = ${at}
        WHERE tenant_id = ${this.actor.tenantId} AND id = ${id}`;
      await this.audit(tx, "payroll_run.compute", "payroll_run", id, { employees: computed.length, gross: totals.gross.toString(), net: totals.net.toString() });
    });
    return { run: await this.getRun(id), payslips: await this.listPayslips(id) };
  }

  /**
   * Validation : une seule écriture au journal de paie, datée du dernier jour
   * du mois (ou de la date fournie) :
   *   D 661 brut, D 664 charges patronales
   *   C 422 net à payer par salarié, C 421 acomptes par salarié,
   *   C 431 cotisations (salariales + patronales) par organisme, C 447 impôt retenu.
   */
  async validateRun(id: Id, opts: { date?: string } = {}): Promise<{ run: PayrollRun; entryId: Id }> {
    const run = await this.getRun(id);
    if (run.status !== "COMPUTED") throw new PayrollError("RUN_STATUS", `Cycle ${periodLabel(run.year, run.month)} : calcul requis avant validation (statut ${run.status})`);
    const scheme = await this.scheme();
    const payslips = await this.listPayslips(id);
    if (payslips.length === 0) throw new PayrollError("RUN_EMPTY", "Aucun bulletin dans ce cycle");
    const employees = new Map((await this.listEmployees()).map((e) => [e.id, e]));
    const label = `Paie ${periodLabel(run.year, run.month)}`;
    const lines: JournalLineInput[] = [];
    const push = (l: JournalLineInput) => {
      const amount = l.debit ?? l.credit;
      if (amount && !Money.parse(amount).isZero()) lines.push(l);
    };
    push({ accountNumber: scheme.accounts.gross, debit: run.totalGross, label: "Rémunérations brutes" });
    push({ accountNumber: scheme.accounts.employerCharges, debit: run.totalEmployerContributions, label: "Charges sociales patronales" });
    for (const p of payslips) {
      const e = employees.get(p.employeeId);
      if (!e) throw new PayrollError("EMPLOYEE_NOT_FOUND", `Salarié ${p.employeeId} introuvable`);
      push({ accountNumber: scheme.accounts.netDue, credit: p.netToPay, partnerId: e.partnerId, label: `Net à payer ${e.matricule} ${fullName(e.lastName, e.firstName)}` });
      push({ accountNumber: scheme.accounts.advances, credit: p.advance, partnerId: e.partnerId, label: `Acompte ${e.matricule}` });
    }
    // Cotisations : une ligne par organisme (compte + identifiant), parts salariale et patronale confondues.
    const byBody = new Map<string, { account: string; label: string; amount: Money }>();
    let incomeTax = Money.zero();
    for (const p of payslips) {
      for (const l of p.lines) {
        if (l.kind === "CONTRIBUTION") {
          const key = `${l.account}|${l.id}`;
          const cur = byBody.get(key) ?? { account: l.account, label: `Cotisations ${l.label}`, amount: Money.zero() };
          cur.amount = cur.amount.add(Money.parse(l.employee_amount)).add(Money.parse(l.employer_amount));
          byBody.set(key, cur);
        } else if (l.kind === "TAX") {
          incomeTax = incomeTax.add(Money.parse(l.employee_amount));
        }
      }
    }
    for (const b of byBody.values()) push({ accountNumber: b.account, credit: b.amount, label: b.label });
    push({ accountNumber: scheme.incomeTax?.account ?? scheme.accounts.incomeTax, credit: incomeTax, label: scheme.incomeTax?.label ?? "Impôt sur salaires retenu" });

    const entry = await this.ledger.post(this.actor, {
      journalCode: "PA",
      date: opts.date ?? lastDayOfMonth(run.year, run.month),
      reference: `PAIE-${run.year}-${String(run.month).padStart(2, "0")}`,
      label,
      source: "PAYROLL",
      lines,
    });
    const at = this.now().toISOString();
    await this.tx(async (tx) => {
      const updated = await tx`
        UPDATE payroll_run SET status = 'VALIDATED', entry_id = ${entry.id}, validated_by = ${this.actor.userId}, validated_at = ${at}
        WHERE tenant_id = ${this.actor.tenantId} AND id = ${id} AND status = 'COMPUTED' RETURNING id`;
      if (updated.length === 0) throw new PayrollError("RUN_STATUS", "Cycle modifié pendant la validation");
      await this.audit(tx, "payroll_run.validate", "payroll_run", id, { entryId: entry.id, number: entry.number });
    });
    return { run: await this.getRun(id), entryId: entry.id };
  }

  /** Règlement des salaires : D 422 par salarié, C compte de trésorerie (521 banque, 571 caisse, 5381 mobile money…). */
  async payRun(id: Id, treasuryAccountNumber: string, date: string): Promise<{ run: PayrollRun; entryId: Id }> {
    const run = await this.getRun(id);
    if (run.status !== "VALIDATED") throw new PayrollError("RUN_STATUS", `Cycle ${periodLabel(run.year, run.month)} : validation requise avant paiement (statut ${run.status})`);
    if (!/^5\d{1,12}$/.test(treasuryAccountNumber)) throw new PayrollError("INVALID_INPUT", `Compte de trésorerie invalide : ${treasuryAccountNumber} (classe 5 attendue)`);
    const scheme = await this.scheme();
    const payslips = await this.listPayslips(id);
    const employees = new Map((await this.listEmployees()).map((e) => [e.id, e]));
    const lines: JournalLineInput[] = [];
    let total = Money.zero();
    for (const p of payslips) {
      const net = Money.parse(p.netToPay);
      if (net.isZero()) continue;
      const e = employees.get(p.employeeId)!;
      lines.push({ accountNumber: scheme.accounts.netDue, debit: net, partnerId: e.partnerId, label: `Salaire ${e.matricule} ${fullName(e.lastName, e.firstName)}` });
      total = total.add(net);
    }
    if (total.isZero()) throw new PayrollError("RUN_EMPTY", "Aucun net à payer dans ce cycle");
    lines.push({ accountNumber: treasuryAccountNumber, credit: total, label: `Salaires ${periodLabel(run.year, run.month)}` });
    const entry = await this.ledger.post(this.actor, {
      journalCode: treasuryAccountNumber.startsWith("57") ? "CA" : "BQ",
      date,
      reference: `PAIE-${run.year}-${String(run.month).padStart(2, "0")}-REG`,
      label: `Règlement salaires ${periodLabel(run.year, run.month)}`,
      source: "PAYROLL",
      lines,
    });
    const at = this.now().toISOString();
    await this.tx(async (tx) => {
      const updated = await tx`
        UPDATE payroll_run SET status = 'PAID', payment_entry_id = ${entry.id}, paid_at = ${at}
        WHERE tenant_id = ${this.actor.tenantId} AND id = ${id} AND status = 'VALIDATED' RETURNING id`;
      if (updated.length === 0) throw new PayrollError("RUN_STATUS", "Cycle modifié pendant le paiement");
      await this.audit(tx, "payroll_run.pay", "payroll_run", id, { entryId: entry.id, treasuryAccount: treasuryAccountNumber, total: total.toString() });
    });
    return { run: await this.getRun(id), entryId: entry.id };
  }

  // ---------------------------------------------------------------------------
  // Bulletins
  // ---------------------------------------------------------------------------
  async listPayslips(runId: Id): Promise<Payslip[]> {
    const rows = await this.tx((tx) => tx`
      SELECT p.* FROM payslip p JOIN employee e ON e.id = p.employee_id
       WHERE p.tenant_id = ${this.actor.tenantId} AND p.run_id = ${runId} ORDER BY e.last_name, e.first_name`);
    return rows.map(mapPayslip);
  }

  async getPayslip(id: Id): Promise<Payslip> {
    const rows = await this.tx((tx) => tx`SELECT * FROM payslip WHERE tenant_id = ${this.actor.tenantId} AND id = ${id}`);
    if (!rows[0]) throw new PayrollError("PAYSLIP_NOT_FOUND", `Bulletin ${id} introuvable`);
    return mapPayslip(rows[0]);
  }

  /** Données prêtes pour le rendu du bulletin (PDF, écran, portail salarié). */
  async payslipView(id: Id): Promise<PayslipView> {
    const payslip = await this.getPayslip(id);
    const [run, employee, company, pack] = await Promise.all([this.getRun(payslip.runId), this.getEmployee(payslip.employeeId), this.company(), this.pack()]);
    const fmt = (v: string) => Money.parse(v).format(payslip.currency);
    const decorate = <T extends PayslipLine>(l: T) => ({ ...l, formatted: fmt(l.employee_amount) });
    const pick = (kind: PayslipLine["kind"]) => payslip.lines.filter((l) => l.kind === kind);
    return {
      payslip,
      run: { id: run.id, year: run.year, month: run.month, status: run.status, periodLabel: periodLabel(run.year, run.month), packVersion: run.packVersion },
      company: { id: company.id, name: company.name, countryCode: company.countryCode.toUpperCase(), currency: company.currency, taxIds: company.taxIds },
      employee: {
        id: employee.id,
        matricule: employee.matricule,
        fullName: fullName(employee.lastName, employee.firstName),
        hireDate: employee.hireDate,
        contractType: employee.contractType,
        category: employee.category,
        socialSecurityNumber: employee.socialSecurityNumber,
        dependants: employee.dependants,
        bankDetails: employee.bankDetails,
      },
      sections: {
        earnings: pick("EARNING").map(decorate),
        deductions: pick("DEDUCTION").map(decorate),
        contributions: pick("CONTRIBUTION").map((l) => ({ ...decorate(l), formattedEmployer: fmt(l.employer_amount) })),
        taxes: pick("TAX").map(decorate),
        advances: pick("ADVANCE").map(decorate),
      },
      totals: {
        gross: fmt(payslip.gross),
        taxableBase: fmt(payslip.taxableBase),
        employeeContributions: fmt(payslip.employeeContributions),
        employerContributions: fmt(payslip.employerContributions),
        incomeTax: fmt(payslip.incomeTax),
        net: fmt(payslip.net),
        advance: fmt(payslip.advance),
        netToPay: fmt(payslip.netToPay),
        employerCost: fmt(payslip.employerCost),
      },
      official: isPackPublished(pack),
      packNotice: draftPackNotice(pack),
    };
  }

  // ---------------------------------------------------------------------------
  // Livre de paie et déclarations
  // ---------------------------------------------------------------------------
  /** Livre de paie annuel : un salarié × un mois, cycles validés ou payés. */
  async payrollBook(year: number): Promise<PayrollBook> {
    const company = await this.company();
    const rows = await this.tx((tx) => tx`
      SELECT p.employee_id, e.matricule, e.first_name, e.last_name, r.month, r.status,
             p.gross::text AS gross, p.employee_contributions::text AS employee_contributions, p.employer_contributions::text AS employer_contributions,
             p.income_tax::text AS income_tax, p.net::text AS net, p.net_to_pay::text AS net_to_pay, p.employer_cost::text AS employer_cost
        FROM payslip p
        JOIN payroll_run r ON r.id = p.run_id
        JOIN employee e ON e.id = p.employee_id
       WHERE p.tenant_id = ${this.actor.tenantId} AND r.year = ${year} AND r.status IN ('VALIDATED', 'PAID')
       ORDER BY e.last_name, e.first_name, r.month`);
    const book: PayrollBookRow[] = rows.map((r) => ({
      employeeId: r.employee_id as string,
      matricule: r.matricule as string,
      fullName: fullName(r.last_name as string, r.first_name as string),
      year,
      month: Number(r.month),
      runStatus: r.status as PayrollRun["status"],
      gross: r.gross as string,
      employeeContributions: r.employee_contributions as string,
      employerContributions: r.employer_contributions as string,
      incomeTax: r.income_tax as string,
      net: r.net as string,
      netToPay: r.net_to_pay as string,
      employerCost: r.employer_cost as string,
    }));
    const totalsOf = (list: PayrollBookRow[]) => Object.fromEntries(MONEY_TOTALS.map((k) => [k, sum(list.map((r) => Money.parse(r[k]))).toString()])) as PayrollBook["totals"];
    const months = [...new Set(book.map((r) => r.month))].sort((a, b) => a - b).map((month) => {
      const list = book.filter((r) => r.month === month);
      return { month, employees: list.length, ...totalsOf(list) };
    });
    return { year, currency: company.currency, rows: book, months, totals: totalsOf(book) };
  }

  /**
   * Déclarations de la période : agrège les bulletins du cycle par organisme
   * (cotisations salariales + patronales) et pour l'impôt sur salaires, puis
   * mémorise le résultat (statut DRAFT ; une déclaration déposée n'est plus recalculée).
   */
  async declarations(period: PayrollPeriod): Promise<PayrollDeclaration[]> {
    checkPeriod(period.year, period.month);
    const runs = await this.listRuns({ year: period.year });
    const run = runs.find((r) => r.month === period.month);
    if (!run) throw new PayrollError("RUN_NOT_FOUND", `Aucun cycle de paie pour ${periodLabel(period.year, period.month)}`);
    if (run.status === "DRAFT") throw new PayrollError("RUN_STATUS", `Cycle ${periodLabel(period.year, period.month)} non calculé`);
    // Les déclarations de la période partent à la CNPS / l'IPRES / la DGI :
    // documents légaux, pack publié exigé.
    const use = await this.officialFor(`Déclarations sociales et fiscales de paie ${periodLabel(period.year, period.month)}`);
    const scheme = await this.scheme();
    const payslips = await this.listPayslips(run.id);
    const agg = new Map<string, { kind: string; label: string; account: string; base: Money; employee: Money; employer: Money }>();
    const bump = (kind: string, label: string, account: string, base: string, employee: string, employer: string) => {
      const cur = agg.get(kind) ?? { kind, label, account, base: Money.zero(), employee: Money.zero(), employer: Money.zero() };
      cur.base = cur.base.add(Money.parse(base));
      cur.employee = cur.employee.add(Money.parse(employee));
      cur.employer = cur.employer.add(Money.parse(employer));
      agg.set(kind, cur);
    };
    // Toutes les cotisations du schéma apparaissent, même à zéro.
    for (const c of scheme.contributions) agg.set(c.kind, { kind: c.kind, label: c.label, account: c.account, base: Money.zero(), employee: Money.zero(), employer: Money.zero() });
    if (scheme.incomeTax) agg.set(scheme.incomeTax.kind, { kind: scheme.incomeTax.kind, label: scheme.incomeTax.label, account: scheme.incomeTax.account, base: Money.zero(), employee: Money.zero(), employer: Money.zero() });
    for (const p of payslips) {
      for (const l of p.lines) {
        if (l.kind === "CONTRIBUTION") bump(l.id.toUpperCase(), l.label, l.account, l.base, l.employee_amount, l.employer_amount);
        else if (l.kind === "TAX") bump(l.id.toUpperCase(), l.label, l.account, l.base, l.employee_amount, "0");
      }
    }
    await this.tx(async (tx) => {
      for (const d of agg.values()) {
        await tx`
          INSERT INTO payroll_declaration (tenant_id, kind, label, year, month, base, employee_amount, employer_amount, amount, account, official)
          VALUES (${this.actor.tenantId}, ${d.kind}, ${d.label}, ${period.year}, ${period.month}, ${d.base.toString()}, ${d.employee.toString()},
                  ${d.employer.toString()}, ${d.employee.add(d.employer).toString()}, ${d.account}, ${use.official})
          ON CONFLICT (tenant_id, kind, year, month) DO UPDATE
            SET label = EXCLUDED.label, base = EXCLUDED.base, employee_amount = EXCLUDED.employee_amount, employer_amount = EXCLUDED.employer_amount,
                amount = EXCLUDED.amount, account = EXCLUDED.account, official = EXCLUDED.official, updated_at = now()
            WHERE payroll_declaration.status = 'DRAFT'`;
      }
    });
    return this.listDeclarations(period);
  }

  async listDeclarations(period: PayrollPeriod): Promise<PayrollDeclaration[]> {
    const rows = await this.tx((tx) => tx`
      SELECT * FROM payroll_declaration WHERE tenant_id = ${this.actor.tenantId} AND year = ${period.year} AND month = ${period.month} ORDER BY kind`);
    return rows.map(mapDeclaration);
  }

  /** Marque une déclaration comme déposée (référence du portail / récépissé). */
  async fileDeclaration(id: Id, filingReference: string): Promise<PayrollDeclaration> {
    const use = await this.officialFor("Dépôt d'une déclaration de paie");
    const at = this.now().toISOString();
    const rows = await this.tx(async (tx) => {
      const updated = await tx`
        UPDATE payroll_declaration SET status = 'FILED', filing_reference = ${filingReference}, filed_at = ${at},
          official = ${use.official}, updated_at = now()
        WHERE tenant_id = ${this.actor.tenantId} AND id = ${id} RETURNING *`;
      if (updated[0]) await this.audit(tx, "payroll_declaration.file", "payroll_declaration", id, { filingReference, official: use.official, pack: use.packReference });
      return updated;
    });
    if (!rows[0]) throw new PayrollError("DECLARATION_NOT_FOUND", `Déclaration ${id} introuvable`);
    return mapDeclaration(rows[0]);
  }
}

// -----------------------------------------------------------------------------
// Utilitaires
// -----------------------------------------------------------------------------
function employeeSelect(tx: Sql) {
  return tx`
    SELECT e.id, e.tenant_id, e.partner_id, e.matricule, e.first_name, e.last_name, e.hire_date::text AS hire_date, e.leave_date::text AS leave_date,
           e.contract_type, e.category, e.base_salary_enc, e.allowances, e.bank_details_enc, e.social_security_number_enc, e.tax_id, e.tax_id_enc,
           e.dependants, e.active, e.created_at, e.updated_at
      FROM employee e`;
}

function mapEmployee(r: Record<string, unknown>, cipher: TenantCipher): Employee {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    partnerId: r.partner_id as string,
    matricule: r.matricule as string,
    firstName: r.first_name as string,
    lastName: r.last_name as string,
    hireDate: r.hire_date as string,
    leaveDate: (r.leave_date as string | null) ?? null,
    contractType: r.contract_type as Employee["contractType"],
    category: (r.category as string | null) ?? null,
    baseSalary: cipher.decrypt(r.base_salary_enc as string),
    allowances: (r.allowances as Allowance[]) ?? [],
    bankDetails: r.bank_details_enc ? cipher.decryptJson<BankDetails>(r.bank_details_enc as string) : null,
    socialSecurityNumber: r.social_security_number_enc ? cipher.decrypt(r.social_security_number_enc as string) : null,
    taxId: decryptTaxId(cipher, r.tax_id_enc as string | null, r.tax_id as string | null),
    dependants: Number(r.dependants),
    active: Boolean(r.active),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

/** Rotation de la clé de données d'un dossier (tâche d'exploitation, rotation annuelle). */
export async function rotateTenantKey(opts: PayrollServiceOptions): Promise<{ version: number; previousVersion: number; reencrypted: number }> {
  return new PayrollService(opts).rotateTenantKey();
}

function mapRun(r: Record<string, unknown>): PayrollRun {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    year: Number(r.year),
    month: Number(r.month),
    status: r.status as PayrollRun["status"],
    packVersion: r.pack_version as string,
    employeeCount: Number(r.employee_count),
    totalGross: String(r.total_gross),
    totalEmployeeContributions: String(r.total_employee_contributions),
    totalEmployerContributions: String(r.total_employer_contributions),
    totalIncomeTax: String(r.total_income_tax),
    totalNet: String(r.total_net),
    totalEmployerCost: String(r.total_employer_cost),
    entryId: (r.entry_id as string | null) ?? null,
    paymentEntryId: (r.payment_entry_id as string | null) ?? null,
    createdAt: toIso(r.created_at),
    computedAt: r.computed_at ? toIso(r.computed_at) : null,
    validatedAt: r.validated_at ? toIso(r.validated_at) : null,
    paidAt: r.paid_at ? toIso(r.paid_at) : null,
  };
}

function mapPayslip(r: Record<string, unknown>): Payslip {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    runId: r.run_id as string,
    employeeId: r.employee_id as string,
    currency: r.currency as string,
    gross: String(r.gross),
    taxableBase: String(r.taxable_base),
    employeeContributions: String(r.employee_contributions),
    employerContributions: String(r.employer_contributions),
    incomeTax: String(r.income_tax),
    net: String(r.net),
    advance: String(r.advance),
    netToPay: String(r.net_to_pay),
    employerCost: String(r.employer_cost),
    lines: (r.lines as PayslipLine[]) ?? [],
    inputs: (r.inputs as PayslipInputs) ?? {},
    pdfDocumentId: (r.pdf_document_id as string | null) ?? null,
    computedAt: toIso(r.computed_at),
  };
}

function mapDeclaration(r: Record<string, unknown>): PayrollDeclaration {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    kind: r.kind as string,
    label: r.label as string,
    year: Number(r.year),
    month: Number(r.month),
    base: String(r.base),
    employeeAmount: String(r.employee_amount),
    employerAmount: String(r.employer_amount),
    amount: String(r.amount),
    account: r.account as string,
    status: r.status as PayrollDeclaration["status"],
    filingReference: (r.filing_reference as string | null) ?? null,
    filedAt: r.filed_at ? toIso(r.filed_at) : null,
    official: r.official === undefined || r.official === null ? true : Boolean(r.official),
  };
}

function validateEmployeeInput(input: EmployeeInput): void {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!input.matricule.trim()) throw new PayrollError("INVALID_INPUT", "Matricule requis");
  if (!input.firstName.trim() || !input.lastName.trim()) throw new PayrollError("INVALID_INPUT", "Nom et prénom requis");
  if (!isoDate.test(input.hireDate)) throw new PayrollError("INVALID_INPUT", "Date d'embauche invalide (AAAA-MM-JJ)");
  if (input.leaveDate !== undefined && (!isoDate.test(input.leaveDate) || input.leaveDate < input.hireDate)) throw new PayrollError("INVALID_INPUT", "Date de sortie invalide");
  let salary: Money;
  try {
    salary = Money.parse(input.baseSalary);
  } catch {
    throw new PayrollError("INVALID_INPUT", `Salaire de base invalide : ${input.baseSalary}`);
  }
  if (!salary.isPositive()) throw new PayrollError("INVALID_INPUT", "Salaire de base : montant nul ou négatif");
  for (const a of input.allowances ?? []) {
    try {
      if (Money.parse(a.amount).isNegative()) throw new Error("négatif");
    } catch {
      throw new PayrollError("INVALID_INPUT", `Indemnité ${a.code} : montant invalide`);
    }
  }
  if (input.dependants !== undefined && (!Number.isInteger(input.dependants) || input.dependants < 0)) throw new PayrollError("INVALID_INPUT", "Personnes à charge : entier positif attendu");
}

function checkPeriod(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new PayrollError("INVALID_INPUT", `Période invalide : ${year}-${month}`);
  }
}

/** Champs non sensibles d'un salarié, seuls admis dans la piste d'audit. */
function publicFields(e: Pick<Employee, "matricule" | "firstName" | "lastName" | "hireDate"> & { leaveDate?: string | null; contractType?: string; category?: string | null; active?: boolean }) {
  return { matricule: e.matricule, name: fullName(e.lastName, e.firstName), hireDate: e.hireDate, leaveDate: e.leaveDate ?? null, contractType: e.contractType ?? "CDI", category: e.category ?? null, active: e.active ?? true };
}

export function fullName(lastName: string, firstName: string): string {
  return `${lastName.toUpperCase()} ${firstName}`;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Décimales d'affichage d'une devise (réexport pratique pour les vues). */
export function currencyDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency] ?? 2;
}
