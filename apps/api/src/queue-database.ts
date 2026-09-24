/** The queue connection is deliberately separate from tenant-data access. */
export function queueDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_ENV !== "production") return env.QUEUE_DATABASE_URL?.trim() || undefined;
  const url = env.QUEUE_DATABASE_URL?.trim();
  if (!url) throw new Error("QUEUE_DATABASE_URL absent : le rôle de file dédié est obligatoire en production");
  return url;
}

export function assertDistinctDatabaseUrls(appUrl: string | undefined, queueUrl: string | undefined): void {
  if (appUrl && queueUrl && appUrl === queueUrl)
    throw new Error("APP_DATABASE_URL et QUEUE_DATABASE_URL doivent pointer vers des connexions distinctes");
}