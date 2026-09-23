// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Outillage PostgreSQL commun aux scripts d'exploitation, et — surtout — le
 * garde-fou qui empêche une restauration d'écraser une base vivante.
 *
 * Le mode de défaillance à concevoir contre n'est pas « la restauration
 * échoue » : c'est « la restauration réussit, sur la mauvaise base ». Une
 * commande juste, lancée avec le `DATABASE_URL` de production encore dans le
 * terminal, détruit dix ans d'écritures sans rien afficher d'anormal. D'où une
 * règle explicite, refusée par défaut, et jamais contournable par un simple
 * drapeau `--force` : il faut retaper le nom de la base **et** poser une
 * variable d'environnement.
 */

import { spawn } from "node:child_process";

/** Nom de base reconnu comme cible jetable. Volontairement étroit. */
export const SCRATCH_PATTERN = /(^|[_-])(drill|scratch|restore|tmp|temp|test|sandbox)([_-]|\d|$)/i;

export interface Target {
  url: string;
  host: string;
  port: string;
  database: string;
  user: string;
  /** Vrai si le nom de la base annonce lui-même une cible jetable. */
  scratch: boolean;
}

export function parseTarget(url: string): Target {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL PostgreSQL illisible (attendu postgres://utilisateur@hôte:5432/base).");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database === "") throw new Error("URL PostgreSQL sans nom de base.");
  return {
    url,
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
    user: decodeURIComponent(parsed.username) || "(par défaut)",
    scratch: SCRATCH_PATTERN.test(database),
  };
}

/** Remplace le nom de la base dans une URL, sans toucher aux identifiants. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** URL sans mot de passe, pour l'affichage et les journaux. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "********";
    return parsed.toString();
  } catch {
    return "<url illisible>";
  }
}

export class DestructiveRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestructiveRefusal";
  }
}

export interface DestructiveGuardOptions {
  target: Target;
  /** Nom de base retapé à la main par l'opérateur (`--confirm <base>`). */
  confirm?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export const DESTRUCTIVE_OPT_IN = "ALLOW_DESTRUCTIVE_RESTORE";

/**
 * Autorise — ou refuse — d'écrire sur la cible. Deux chemins, un seul par
 * défaut :
 *
 *  - le nom de la base annonce une cible jetable (`…_drill`, `…_test`,
 *    `scratch_…`) : on y va, c'est le cas de l'exercice trimestriel ;
 *  - sinon, il faut **les deux** : `--confirm <nom exact de la base>` et
 *    `ALLOW_DESTRUCTIVE_RESTORE=1`. Un seul des deux ne suffit pas, parce
 *    qu'une variable oubliée dans un shell ou un nom copié-collé au hasard
 *    doivent rester sans effet.
 *
 * C'est le chemin d'une vraie reprise de production : il existe, il est
 * documenté, et il ne s'emprunte pas par distraction.
 */
export function assertWritableTarget(opts: DestructiveGuardOptions): { scratch: boolean } {
  const { target } = opts;
  const env = opts.env ?? process.env;
  if (target.scratch) return { scratch: true };

  const confirmed = opts.confirm !== undefined && opts.confirm === target.database;
  const optedIn = ["1", "true", "yes"].includes((env[DESTRUCTIVE_OPT_IN] ?? "").trim().toLowerCase());
  if (confirmed && optedIn) return { scratch: false };

  throw new DestructiveRefusal(
    [
      `Refus d'écrire sur « ${target.database} » (${target.host}:${target.port}) : ce nom n'annonce pas une base jetable.`,
      "",
      "Une restauration écrase tout ce que la base contient. Deux façons de continuer, et aucune par accident :",
      `  · viser une base dont le nom le dit (…_drill, …_test, scratch_…) — c'est ce que fait scripts/restore-drill.mts ;`,
      `  · pour une vraie reprise, retaper le nom exact ET poser la variable :`,
      `        ${DESTRUCTIVE_OPT_IN}=1 pnpm exec tsx scripts/restore.mts --target <url> --file <archive> --confirm ${target.database}`,
      "",
      confirmed ? `  (${DESTRUCTIVE_OPT_IN} n'est pas posée.)` : opts.confirm === undefined ? "  (--confirm n'a pas été fourni.)" : `  (--confirm « ${opts.confirm} » ne correspond pas à « ${target.database} ».)`,
    ].join("\n"),
  );
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Lance une commande et rend son résultat ; la sortie d'erreur est conservée pour le rapport. */
export function run(command: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => reject(new Error(`${command} introuvable ou non exécutable : ${e.message}`)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Une requête ponctuelle, sans ouvrir un pool : `psql -t -A`. */
export async function psqlValue(url: string, sql: string): Promise<string> {
  const res = await run("psql", [url, "-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (res.code !== 0) throw new Error(`psql a échoué : ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout.trim();
}

/** Argument nommé d'une ligne de commande : `--clé valeur` ou `--clé=valeur`. */
export function arg(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith("--")) return argv[index + 1];
  return undefined;
}

export const flag = (argv: string[], name: string): boolean => argv.includes(`--${name}`);

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
