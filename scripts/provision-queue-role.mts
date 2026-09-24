/** Creates/rotates the least-privilege queue login. Secrets come only from env. */
import { createDb } from "../packages/db/src/client.js";
import { DEFAULT_QUEUE_LOGIN, ProvisionError, provisionQueueRole } from "../packages/db/src/provision.js";

const adminUrl = process.env.DATABASE_URL;
const password = process.env.QUEUE_DB_PASSWORD;
if (!adminUrl) throw new Error("DATABASE_URL manquant : compte propriétaire des migrations requis");
if (!password) throw new Error("QUEUE_DB_PASSWORD manquant : secret obligatoire, jamais codé en dur");
const login = process.env.QUEUE_DB_USER?.trim() || DEFAULT_QUEUE_LOGIN;
const db = createDb({ url: adminUrl, max: 1 });
try {
  const result = await provisionQueueRole(db, { login, password });
  console.log(`✓ rôle ${result.login} ${result.created ? "créé" : "remis en conformité"} (membre de ${result.memberOf})`);
  if (!result.privileges.ok) {
    throw new Error(`Droits de table interdits accordés au rôle de file : ${result.privileges.violations.map((v) => `${v.table}.${v.privilege}`).join(", ")}`);
  }
} catch (e) {
  if (e instanceof ProvisionError) throw new Error(e.message);
  throw e;
} finally { await db.end(); }