# syntax=docker/dockerfile:1.7
#
# Image Web — sortie « standalone » de Next.js.
#
# `next build` en mode standalone trace les modules réellement atteints par le
# serveur et les recopie dans `.next/standalone` : l'image finale n'embarque ni
# pnpm, ni les dépendances de développement (tailwind, postcss, types React), ni
# les sources TypeScript. Seuls s'y ajoutent les fichiers que Next ne recopie
# jamais : `.next/static` (les bundles servis au navigateur) et `public/`.
#
# Le navigateur n'appelle JAMAIS l'API directement : `lib/api-client.ts` passe
# par `/api/proxy/…`, une route serveur qui ajoute l'en-tête d'autorisation.
# L'image n'a donc pas besoin d'une URL d'API figée à la construction ; seule
# `API_URL` (vue depuis le conteneur) compte, et elle est lue à l'exécution.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN find packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +
RUN pnpm install --frozen-lockfile --filter @arcompt/web...

FROM deps AS build
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# `apps/web/next.config.ts` ne fixe pas `output`. NEXT_PRIVATE_STANDALONE est la
# variable que Next lit pour en faire la valeur par défaut (next/dist/server/
# config-shared.js). Le réglage propre serait `output: "standalone"` dans
# next.config.ts ; ce fichier n'appartient pas à ce lot de travail.
ENV NEXT_PRIVATE_STANDALONE=1
RUN pnpm --filter @arcompt/web build
# Next ne recopie pas ces deux répertoires dans la sortie standalone.
RUN cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
  && cp -r apps/web/public apps/web/.next/standalone/apps/web/public \
  && test -f apps/web/.next/standalone/apps/web/server.js

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
# Cache d'exécution de Next (rendu incrémental) : doit appartenir à l'utilisateur.
RUN mkdir -p apps/web/.next/cache && chown -R node:node apps/web/.next/cache
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
