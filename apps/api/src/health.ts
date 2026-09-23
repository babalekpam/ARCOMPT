// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Context } from "hono";
import type { Sql } from "postgres";

/**
 * Sondes d'exploitation.
 *
 * Deux points distincts, parce qu'ils répondent à deux questions différentes :
 *
 *  - `/health` (vivacité) : le processus répond-il ? Il ne touche à rien, ne
 *    dépend de rien, et reste vert pendant l'arrêt en douceur — un échec doit
 *    signifier « redémarrez ce conteneur », jamais « la base est tombée ».
 *  - `/ready` (aptitude) : ce processus peut-il servir du trafic ? Il fait un
 *    aller-retour réel vers PostgreSQL avec un délai court, et répond 503 dès
 *    qu'une dépendance requise manque ou que l'arrêt a commencé. C'est ce point
 *    que l'équilibreur de charge interroge pour mettre l'instance en rotation.
 *
 * Le corps ne divulgue jamais de détail interne (message d'erreur, hôte, port,
 * identifiants) : il se limite à l'état par dépendance. Le détail part dans les
 * journaux via `onFailure`.
 */

/** Délai d'une sonde : court, sinon l'aptitude devient elle-même une panne. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export type DependencyState = "up" | "down" | "draining" | "not_configured";

export interface DependencyReport {
  readonly name: string;
  readonly state: DependencyState;
}

export interface ReadinessReport {
  readonly ready: boolean;
  /** 200 si l'instance peut servir, 503 sinon : rien d'autre n'est utile à un équilibreur. */
  readonly status: 200 | 503;
  readonly dependencies: readonly DependencyReport[];
}

export interface DependencyProbe {
  readonly name: string;
  /** Contrôle effectif : toute exception ou tout dépassement de délai vaut « down ». */
  readonly check: () => Promise<unknown>;
  /** Une dépendance facultative en panne est signalée mais ne bloque pas la rotation. */
  readonly required?: boolean;
}

export interface ReadinessOptions {
  /** Connexion PostgreSQL ; absente, la dépendance est déclarée `not_configured` (tests en mémoire). */
  db?: Sql;
  /** Sondes supplémentaires (file de tâches, stockage…) ajoutées après la base. */
  probes?: readonly DependencyProbe[];
  timeoutMs?: number;
  /** Journalisation du détail de la panne : il ne doit jamais atteindre la réponse HTTP. */
  onFailure?: (name: string, error: unknown) => void;
  /** Source de l'état d'arrêt ; par défaut l'état du processus courant. */
  draining?: () => boolean;
}

// ---------------------------------------------------------------------------
// État d'arrêt du processus : partagé entre le gestionnaire de signal et la
// sonde d'aptitude, pour que l'instance sorte de la rotation avant de fermer
// son serveur HTTP.
// ---------------------------------------------------------------------------
let draining = false;

/** Marque le processus comme en cours d'arrêt : `/ready` répond 503 dès l'appel. */
export function beginDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** Réinitialisation réservée aux tests. */
export function resetDraining(): void {
  draining = false;
}

class ProbeTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`sonde ${name} : délai de ${ms} ms dépassé`);
    this.name = "ProbeTimeoutError";
  }
}

async function withTimeout<T>(name: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError(name, ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Aller-retour minimal vers PostgreSQL : il prouve la connexion, pas le schéma. */
export function databaseProbe(db: Sql): DependencyProbe {
  return { name: "database", check: () => Promise.resolve(db`SELECT 1`), required: true };
}

/** Exécute les sondes et construit le rapport d'aptitude. */
export async function checkReadiness(options: ReadinessOptions = {}): Promise<ReadinessReport> {
  const drainingNow = (options.draining ?? isDraining)();
  if (drainingNow) {
    // Arrêt en cours : inutile d'interroger les dépendances, l'instance doit
    // sortir de la rotation immédiatement.
    return { ready: false, status: 503, dependencies: [{ name: "process", state: "draining" }] };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const dependencies: DependencyReport[] = [];
  let ready = true;

  if (!options.db) dependencies.push({ name: "database", state: "not_configured" });

  const probes: DependencyProbe[] = [...(options.db ? [databaseProbe(options.db)] : []), ...(options.probes ?? [])];
  for (const probe of probes) {
    try {
      await withTimeout(probe.name, timeoutMs, probe.check);
      dependencies.push({ name: probe.name, state: "up" });
    } catch (error) {
      options.onFailure?.(probe.name, error);
      dependencies.push({ name: probe.name, state: "down" });
      if (probe.required !== false) ready = false;
    }
  }

  return { ready, status: ready ? 200 : 503, dependencies };
}

/** Gestionnaire Hono du point d'aptitude. */
export function readinessHandler(options: ReadinessOptions = {}): (c: Context) => Promise<Response> {
  return async (c) => {
    const report = await checkReadiness(options);
    c.header("cache-control", "no-store");
    return c.json({ ready: report.ready, dependencies: report.dependencies }, report.status);
  };
}
