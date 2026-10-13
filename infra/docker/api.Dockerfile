# syntax=docker/dockerfile:1.7
#
# Image API — JavaScript compilé, sans TypeScript ni pnpm à l'exécution.
#
# L'espace de travail publie ses paquets en sources TypeScript
# (`"main": "./src/index.ts"`) : rien n'est compilé à l'installation, et c'est
# `tsx` qui transpile à la volée en développement. En production on ne veut ni
# transpileur, ni compilateur, ni gestionnaire de paquets dans l'image.
#
# D'où la découpe :
#   manifests  — les seuls package.json + le lockfile (couche très stable) ;
#   deps-dev   — installation complète, uniquement pour disposer de `tsc` ;
#   build      — compilation de TOUT le programme (API + packages) en une passe ;
#   deps-prod  — seconde installation, --prod, sans aucune dépendance de dev ;
#   assemble   — arborescence d'exécution : .js compilé + node_modules élagués ;
#   runtime    — Chromium (rendu PDF), utilisateur non root, et rien d'autre.
#
# L'image finale ne contient ni pnpm, ni corepack, ni typescript, ni tsx.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# --- Manifestes seuls : cette couche ne change que si une dépendance change ---
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `COPY` ne sait pas recopier `packages/*/package.json` en préservant l'arborescence :
# on copie les paquets puis on ne garde que leurs manifestes.
COPY packages ./packages
RUN find packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +

# --- Dépendances complètes : nécessaires pour compiler (typescript est à la racine) ---
FROM manifests AS deps-dev
RUN pnpm install --frozen-lockfile

# --- Compilation : API + tous les paquets de l'espace de travail, en une passe ---
FROM deps-dev AS build
COPY tsconfig.base.json ./
COPY infra/docker/tsconfig.api.json infra/docker/
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web/lib ./apps/web/lib
# `scripts/*.mts` : outils d'exploitation du dépôt (provisionnement du rôle,
# création d'un compte de test). Compilés ici pour être utilisables depuis
# l'image, qui n'embarque ni pnpm ni tsx.
COPY scripts ./scripts
RUN pnpm exec tsc -p infra/docker/tsconfig.api.json

# --- Dépendances d'exécution : --prod, filtrées sur l'API et ses paquets ---
FROM manifests AS deps-prod
RUN pnpm install --frozen-lockfile --prod --filter @arcompt/api...

# --- Assemblage de l'arborescence livrée ---
FROM deps-prod AS assemble
COPY --from=build /app/dist ./dist
COPY infra/docker/assemble-api.mjs infra/docker/
COPY infra/docker/ops infra/docker/ops
# Sources : seuls les fichiers NON TypeScript en seront retenus (migrations SQL,
# packs pays). Les node_modules déjà installés ne sont pas touchés par ce COPY.
COPY packages ./packages
COPY apps/api ./apps/api
RUN node infra/docker/assemble-api.mjs . dist out --move-node-modules

# --- Image finale ---
FROM node:22-bookworm-slim AS runtime
# Chromium pour le rendu PDF (playwright-core ne télécharge aucun navigateur).
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    API_PORT=4000 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=assemble --chown=node:node /app/out ./
USER node
EXPOSE 4000
# `tini` récolte les processus Chromium orphelins et relaie SIGTERM.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/src/server.js"]
