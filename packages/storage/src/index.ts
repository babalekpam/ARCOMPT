import { LocalStorage } from "./local.js";
import { R2Storage, r2OptionsFromEnv } from "./r2.js";
import type { Storage } from "./storage.js";

export * from "./storage.js";
export * from "./local.js";
export * from "./r2.js";

/**
 * R2 si les variables R2_* sont présentes, sinon stockage local dans
 * STORAGE_DIR (défaut ./.data/storage).
 */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
  const r2 = r2OptionsFromEnv(env);
  if (r2) return new R2Storage(r2);
  return new LocalStorage(env.STORAGE_DIR);
}
