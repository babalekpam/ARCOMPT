import assert from "node:assert/strict";
import { createDb } from "../packages/db/src/client.ts";
import { assertProductionDatabaseSecurity } from "../apps/api/src/database-readiness.ts";
import { assertProductionQueueDatabaseSecurity } from "../apps/api/src/queue-database.ts";

// Read-only checks. Never log connection strings, passwords, or raw driver errors.
const hosts = new Set([
  "ep-solitary-dust-avcvy9zn.c-11.us-east-1.aws.neon.tech",
  "ep-solitary-dust-avcvy9zn-pooler.c-11.us-east-1.aws.neon.tech",
]);
let stage = "validate staged connection targets";
const connections: ReturnType<typeof createDb>[] = [];
try {
  const makeConnection = (key: string, role: string) => {
    const value = process.env[key]?.trim();
    assert(value, `${key} is missing`);
    const url = new URL(value);
    assert(["postgres:", "postgresql:"].includes(url.protocol), `${key}: use a PostgreSQL URL`);
    assert(hosts.has(url.hostname), `${key}: wrong Neon branch endpoint`);
    assert.equal(decodeURIComponent(url.pathname.slice(1)), "arcompt", `${key}: database must be arcompt`);
    assert.equal(decodeURIComponent(url.username), role, `${key}: wrong runtime role`);
    assert(url.password, `${key}: password is missing`);
    assert.equal(url.searchParams.get("sslmode"), "require", `${key}: SSL is required`);
    const db = createDb({ url: value, max: 1 });
    connections.push(db);
    return db;
  };
  const app = makeConnection("ARCOMPT_NEON_APP_URL", "arcompt_app_login");
  const queue = makeConnection("ARCOMPT_NEON_QUEUE_URL", "arcompt_queue_login");
  stage = "authenticate application login";
  const [appIdentity] = await app`SELECT current_database() AS db, current_user AS role`;
  assert.equal(appIdentity?.db, "arcompt");
  assert.equal(appIdentity?.role, "arcompt_app_login");
  console.log("PASS: application login authenticated to the expected database");
  stage = "authenticate queue login";
  const [queueIdentity] = await queue`SELECT current_database() AS db, current_user AS role`;
  assert.equal(queueIdentity?.db, "arcompt");
  assert.equal(queueIdentity?.role, "arcompt_queue_login");
  console.log("PASS: queue login authenticated to the expected database");
  stage = "application database security guard";
  await assertProductionDatabaseSecurity(app);
  console.log("PASS: application production database security guard");
  stage = "queue database security guard";
  await assertProductionQueueDatabaseSecurity(queue, app);
  console.log("PASS: queue production database security guard");
  stage = "cross-application database isolation";
  for (const db of connections) {
    const [row] = await db`SELECT has_database_privilege(current_user, 'neondb', 'CONNECT') AS other_db,
      has_database_privilege('navimed_app_rls', 'arcompt', 'CONNECT') AS other_app`;
    assert.equal(row?.other_db, false);
    assert.equal(row?.other_app, false);
  }
  console.log("PASS: runtime database access is isolated from NaviMed");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "CHECK_FAILED";
  console.error(`FAIL: ${stage}; code=${/^[A-Z0-9_]+$/.test(code) ? code : "CHECK_FAILED"}`);
  // Our validation messages contain only key names and fixed labels.
  if (stage === "validate staged connection targets" && error instanceof assert.AssertionError) {
    console.error(error.message.split("\n")[0]);
  }
  process.exitCode = 1;
} finally {
  await Promise.all(connections.map((db) => db.end({ timeout: 5 })));
}