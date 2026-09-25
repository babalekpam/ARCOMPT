#!/usr/bin/env bash
# Sourced only by the production launcher. Development keeps its existing DB.
if [[ -z "${ARCOMPT_NEON_APP_URL:-}" || -z "${ARCOMPT_NEON_QUEUE_URL:-}" ]]; then
  echo "ARCOMPT Neon runtime connections are missing; refusing database fallback." >&2
  return 1
fi
export APP_DATABASE_URL="$ARCOMPT_NEON_APP_URL"
export QUEUE_DATABASE_URL="$ARCOMPT_NEON_QUEUE_URL"
# Any default client in a production child must also use the restricted login,
# never Replit's injected managed-owner connection.
export DATABASE_URL="$APP_DATABASE_URL"