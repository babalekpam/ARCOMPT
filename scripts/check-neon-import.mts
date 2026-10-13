import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDb, withTenant } from "../packages/db/src/client.ts";

// Run only after check-neon-staging.mts confirms the destination and roles.
// The private export is used for identifiers, never printed or committed.
const snapshotPath = process.argv[2];
assert(snapshotPath, "Private source snapshot path is required");
assert(process.env.ARCOMPT_NEON_APP_URL && process.env.ARCOMPT_NEON_QUEUE_URL, "Both staged Neon connections are required");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const entries = snapshot.tables.journal_entry.rows.map((r: string) => JSON.parse(r));
const entry = entries.find((e: { status: string }) => e.status === "VALIDATED");
assert(entry, "Expected a validated source entry");
const other = snapshot.tables.company.rows.map((r: string) => JSON.parse(r))
  .find((c: { id: string }) => c.id !== entry.tenant_id);
assert(other, "Expected a second source company");
const app = createDb({ url: process.env.ARCOMPT_NEON_APP_URL, max: 1 });
const queue = createDb({ url: process.env.ARCOMPT_NEON_QUEUE_URL, max: 1 });
let stage = "contextless reads";
const denied = async (fn: () => Promise<unknown>, codes: string[]) => {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert(code && codes.includes(code), "Unexpected rejection");
    return;
  }
  throw new Error("Forbidden operation was accepted");
};
try {
  const [empty] = await app`SELECT count(*)::int AS n FROM account`;
  assert.equal(empty!.n, 0);
  stage = "tenant-scoped reads";
  await withTenant(app, { tenantId: entry.tenant_id }, async (tx) => {
    const [own] = await tx`SELECT count(*)::int AS n FROM account WHERE tenant_id=${entry.tenant_id}`;
    const [foreign] = await tx`SELECT count(*)::int AS n FROM account WHERE tenant_id=${other.id}`;
    assert(own!.n > 0);
    assert.equal(foreign!.n, 0);
  });
  console.log("PASS: contextless and cross-company reads denied; own-company reads work");
  stage = "validated entry immutability";
  // Every attempted write is enclosed in a transaction and forced to roll back
  // even if the guard unexpectedly allows the statement.
  const attemptWrite = async (sql: string) => withTenant(app, { tenantId: entry.tenant_id }, async (tx) => {
    await tx.unsafe(sql);
    throw new Error("ROLLBACK: forbidden write was unexpectedly accepted");
  });
  await denied(() => attemptWrite("UPDATE journal_entry SET label=label || ' [migration denial test]' WHERE status='VALIDATED'"), ["P0003", "P0001", "42501"]);
  stage = "audit immutability";
  await denied(() => attemptWrite("UPDATE audit_log SET action=action"), ["42501", "P0001"]);
  stage = "direct balance writes";
  await denied(() => attemptWrite("UPDATE account_balance SET debit=debit"), ["42501"]);
  stage = "queue table denial";
  await denied(() => queue`SELECT id FROM background_job LIMIT 1`, ["42501"]);
  stage = "app queue capability denial";
  await denied(() => app`SELECT * FROM background_job_claim(ARRAY[]::text[])`, ["42501"]);
  console.log("PASS: validated ledger, audit, balance, and queue restrictions enforced");
} catch {
  console.error(`FAIL: ${stage}; details withheld to protect source records`);
  process.exitCode = 1;
} finally {
  await Promise.all([app.end({ timeout: 5 }), queue.end({ timeout: 5 })]);
}