#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
clamav="$root/.build/clamav-1.4.6/usr/local"
if [[ ! -x "$clamav/sbin/clamd" || ! -x "$clamav/bin/freshclam" ]]; then
  echo "ClamAV build is missing; refusing to start." >&2
  exit 1
fi
if [[ "${ALLOW_INSECURE_ANTIVIRUS:-}" == 1 || "${ALLOW_INSECURE_STORAGE:-}" == 1 ]]; then
  echo "Insecure dependency opt-outs are not allowed by this production launcher." >&2
  exit 1
fi

export NODE_ENV=production AUTH_MODE=clerk API_PORT=4000 API_URL=http://127.0.0.1:4000
export CHROMIUM_PATH="${CHROMIUM_PATH:-$(command -v chromium || true)}"
export LD_LIBRARY_PATH="$clamav/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

runtime="$(mktemp -d)"
mkdir -p "$runtime/db"
if [[ ! -s "$root/.build/clamav-1.4.6/db/main.cvd" ]]; then
  echo "Build has no ClamAV signatures; refusing to start." >&2
  exit 1
fi
cp -a "$root/.build/clamav-1.4.6/db/." "$runtime/db/"
cat >"$runtime/freshclam.conf" <<EOF
DatabaseDirectory $runtime/db
DatabaseOwner $(id -un)
DatabaseMirror database.clamav.net
Checks 12
EOF
cat >"$runtime/clamd.conf" <<EOF
DatabaseDirectory $runtime/db
TCPSocket 3310
TCPAddr 127.0.0.1
Foreground yes
User $(id -un)
SelfCheck 600
EOF

children=()
api=""
web=""
cleanup() {
  trap - EXIT INT TERM
  # API and web have independent sessions so their Node children cannot outlive
  # the scanner even when their pnpm parent exits.
  if [[ -n "$api" ]]; then kill -- "-$api" 2>/dev/null || true; fi
  if [[ -n "$web" ]]; then kill -- "-$web" 2>/dev/null || true; fi
  if ((${#children[@]})); then kill "${children[@]}" 2>/dev/null || true; fi
  if ((${#children[@]})); then wait "${children[@]}" 2>/dev/null || true; fi
  rm -rf "$runtime"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Download and test current signature databases before making either app public.
# If the update fails (including an empty or obsolete database), do not start.
"$clamav/bin/freshclam" --config-file="$runtime/freshclam.conf"
test -s "$runtime/db/main.cvd"
if [[ ! -s "$runtime/db/daily.cvd" && ! -s "$runtime/db/daily.cld" ]]; then
  echo "ClamAV has no daily signatures; refusing to start." >&2
  exit 1
fi
CLAMAV_DATABASE_DIR="$runtime/db" corepack pnpm exec tsx -e \
  'import { assertRecentClamAvDatabase } from "./packages/documents/src/security.ts"; assertRecentClamAvDatabase(process.env.CLAMAV_DATABASE_DIR!).catch((e) => { console.error(e); process.exitCode = 1; });'
"$clamav/sbin/clamd" --config-file="$runtime/clamd.conf" &
scanner=$!
children+=("$scanner")
ready=0
for ((attempt=0; attempt<120; attempt++)); do
  if ! kill -0 "$scanner" 2>/dev/null; then
    echo "clamd exited before becoming ready." >&2
    exit 1
  fi
  if node scripts/check-clamd.mjs; then ready=1; break; fi
  sleep 2
done
if ((ready != 1)); then
  echo "clamd failed its readiness check." >&2
  exit 1
fi

# Tell the running daemon to reload immediately when freshclam publishes new
# signatures (rather than waiting for clamd's periodic self-check).
printf 'NotifyClamd %s\n' "$runtime/clamd.conf" >> "$runtime/freshclam.conf"
"$clamav/bin/freshclam" --daemon --foreground --config-file="$runtime/freshclam.conf" &
children+=("$!")
export CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310 CLAMAV_DATABASE_DIR="$runtime/db"
setsid corepack pnpm --filter @arcompt/api start &
api=$!
children+=("$api")
setsid corepack pnpm --filter @arcompt/web start &
web=$!
children+=("$web")

# Loss of *any* required process takes the whole deployment down. Uploads also
# fail closed if clamd becomes unavailable before shutdown completes.
wait -n "${children[@]}" || true
echo "A required production process stopped; shutting down." >&2
exit 1