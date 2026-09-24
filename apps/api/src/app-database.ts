/** The managed DATABASE_URL belongs to the schema owner, not to the API.
 * Production must explicitly use a non-privileged login; startup verifies its
 * actual PostgreSQL privileges before opening the HTTP listener.
 */
export function applicationDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_ENV !== "production") return undefined;
  const url = env.APP_DATABASE_URL?.trim();
  if (!url) throw new Error("APP_DATABASE_URL absent : le rôle applicatif restreint est obligatoire en production");
  return url;
}