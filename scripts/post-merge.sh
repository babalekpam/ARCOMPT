#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Post-merge setup runs in development. Never run this script in the
# production deployment build/start command; Publish owns production schema.
export CI=1
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @arcompt/db migrate
