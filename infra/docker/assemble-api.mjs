#!/usr/bin/env node
// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Assemblage de l'image API : transforme la sortie compilée de `tsc` en une
 * arborescence exécutable par `node`, sans TypeScript ni pnpm à l'exécution.
 *
 * Pourquoi ce script existe
 * -------------------------
 * Tous les paquets de l'espace de travail (`packages/*`) publient leurs sources
 * TypeScript : `"main": "./src/index.ts"`. Rien n'est compilé à la publication,
 * et c'est `tsx` qui transpile à la volée en développement. En production on ne
 * veut ni transpileur ni `.ts` : on compile TOUT le programme d'un coup
 * (`infra/docker/tsconfig.api.json`), puis ce script reconstitue la même
 * arborescence que l'espace de travail, mais en `.js`.
 *
 * La disposition relative est conservée à l'identique
 * (`/app/apps/api`, `/app/packages/<nom>`, `/app/node_modules`) : les liens
 * symboliques *relatifs* créés par pnpm (`apps/api/node_modules/@arcompt/db ->
 * ../../../../packages/db`) continuent donc de pointer juste après déplacement.
 *
 * Étapes
 *   1. package.json de chaque membre, avec `.ts` → `.js` dans main/types/exports
 *      et sans les scripts ni les devDependencies ;
 *   2. JavaScript compilé depuis `<dist>/<membre>/src` ;
 *   3. fichiers non TypeScript nécessaires à l'exécution (migrations SQL,
 *      packs pays…), que `tsc` n'émet pas ;
 *   4. scripts d'exploitation — `scripts/` (compilé) et `infra/docker/ops/` —
 *      recopiés à LEUR CHEMIN DU DÉPÔT, pour que leurs imports relatifs soient
 *      vrais dans l'image comme dans le dépôt ;
 *   5. déplacement des `node_modules` installés par pnpm dans l'arborescence
 *      de sortie.
 *
 * Usage : node infra/docker/assemble-api.mjs <racine> <dist> <sortie> [--move-node-modules]
 *
 * `--move-node-modules` DÉPLACE (et donc vide) les `node_modules` de la racine :
 * réservé à l'étape de construction de l'image, jamais sur un poste de travail.
 */
import console from "node:console";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const MOVE_NODE_MODULES = args.includes("--move-node-modules");
const [rootArg = ".", distArg = "dist", outArg = "out"] = args.filter((a) => !a.startsWith("--"));
const ROOT = resolve(rootArg);
const DIST = resolve(distArg);
const OUT = resolve(outArg);

/** Fichiers présents à la racine d'un membre et qui n'ont rien à faire dans l'image. */
const SKIP_AT_MEMBER_ROOT = new Set(["node_modules", "src", "package.json", "tsconfig.json", "tsconfig.tsbuildinfo", "vitest.config.ts", ".turbo"]);

/** Membres de l'espace de travail embarqués dans l'image API. */
function members() {
  const packages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, "packages", e.name, "package.json")))
    .map((e) => `packages/${e.name}`);
  return ["apps/api", ...packages];
}

/** `./src/index.ts` → `./src/index.js`, en profondeur (main, types, exports, bin). */
function toJs(value) {
  if (typeof value === "string") return value.replace(/\.tsx?$/, ".js");
  if (Array.isArray(value)) return value.map(toJs);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJs(v)]));
  return value;
}

/** package.json d'exécution : plus de scripts (pnpm/tsx absents), plus de devDependencies. */
function runtimeManifest(source) {
  const pkg = JSON.parse(readFileSync(source, "utf8"));
  delete pkg.scripts;
  delete pkg.devDependencies;
  for (const field of ["main", "module", "types", "typings", "exports", "bin", "imports"]) {
    if (pkg[field] !== undefined) pkg[field] = toJs(pkg[field]);
  }
  return pkg;
}

/** Copie les fichiers non TypeScript du membre (migrations SQL, packs pays, gabarits…). */
function copyAssets(memberDir, outDir) {
  for (const entry of readdirSync(memberDir, { withFileTypes: true })) {
    if (SKIP_AT_MEMBER_ROOT.has(entry.name)) continue;
    const from = join(memberDir, entry.name);
    const to = join(outDir, entry.name);
    if (entry.isDirectory()) {
      cpSync(from, to, {
        recursive: true,
        filter: (src) => {
          if (/(^|[\\/])node_modules([\\/]|$)/.test(relative(memberDir, src))) return false;
          return !/\.tsx?$/.test(src) || statSync(src).isDirectory();
        },
      });
    } else if (!/\.tsx?$/.test(entry.name)) {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
  }
}

mkdirSync(OUT, { recursive: true });

for (const member of members()) {
  const memberDir = join(ROOT, member);
  const outDir = join(OUT, member);
  const compiled = join(DIST, member, "src");
  if (!existsSync(compiled)) throw new Error(`sortie compilée absente pour ${member} : ${compiled} — la compilation a-t-elle réussi ?`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(runtimeManifest(join(memberDir, "package.json")), null, 2)}\n`);
  cpSync(compiled, join(outDir, "src"), { recursive: true });
  copyAssets(memberDir, outDir);
}

// Manifeste racine minimal : sert d'ancre de résolution, sans script ni dépendance.
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
writeFileSync(
  join(OUT, "package.json"),
  `${JSON.stringify({ name: rootPkg.name, version: rootPkg.version, private: true, type: "module" }, null, 2)}\n`,
);

// Outils d'exploitation. Ils sont recopiés au chemin qu'ils occupent dans le
// dépôt, et non regroupés ailleurs : leurs imports relatifs vers
// `packages/<nom>/src/…` doivent rester vrais dans l'image comme dans le dépôt,
// sinon on ne peut ni les lire ni les exécuter hors conteneur.
//
//   infra/docker/ops/*.mjs  — écrits en JavaScript, recopiés tels quels ;
//   scripts/*.mts           — compilés par tsc en .mjs dans <dist>/scripts.
const ops = join(ROOT, "infra", "docker", "ops");
if (existsSync(ops)) cpSync(ops, join(OUT, "infra", "docker", "ops"), { recursive: true });

const scripts = join(DIST, "scripts");
if (existsSync(scripts)) cpSync(scripts, join(OUT, "scripts"), { recursive: true });

// node_modules installés par pnpm : déplacés tels quels, liens relatifs intacts.
if (MOVE_NODE_MODULES) {
  for (const dir of ["", ...members()]) {
    const from = join(ROOT, dir, "node_modules");
    if (!existsSync(from)) continue;
    const to = join(OUT, dir, "node_modules");
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
    }
  }
}

console.log(`arborescence d'exécution assemblée dans ${OUT}`);
