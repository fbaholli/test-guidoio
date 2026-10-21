#!/usr/bin/env bash
# The whole demo from a fresh clone: Postgres, migrations, the Firestore emulator, seed, two
# backfills (the second must change nothing), reconciliation, the API and a 409. It stops
# whatever it started, and fails loudly if any step doesn't do what the README says.
set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mDEMO FAILED: %s\033[0m\n' "$*" >&2; exit 1; }
wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -s -m 1 "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

started=()
cleanup() {
  for pid in "${started[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -INT "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

bold "Setup"
[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }
set -a; . ./.env; set +a
export LOG_LEVEL=warn # the commands print their own tables; keep the JSON logs quiet
mkdir -p reports
pnpm install --frozen-lockfile --silent

bold "Postgres: start it and build the schema from zero"
pnpm -s db:up
pnpm -s db:reset
echo "schema migrated"

bold "Firestore emulator"
emulator="http://${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}/"
if curl -s -m 1 "$emulator" >/dev/null 2>&1; then
  echo "already running at $emulator"
else
  node_modules/.bin/firebase emulators:start --only firestore --project demo-driving-school \
    >reports/emulator.log 2>&1 &
  started+=("$!")
  wait_for "$emulator" 120 || fail "the emulator didn't start (it needs Java 21+); see reports/emulator.log"
  echo "started at $emulator (UI: http://127.0.0.1:4000)"
fi

bold "Seed messy data"
pnpm -s seed
echo "seeded the emulator"

bold "Backfill"
pnpm -s backfill
first_run=$(ls -t reports/run-*.json | head -1)

bold "Backfill again: every row must come back unchanged"
pnpm -s backfill
second_run=$(ls -t reports/run-*.json | head -1)
[ "$first_run" != "$second_run" ] || fail "the second backfill wrote no report"
idempotency=$(node -e '
  const report = require(process.argv[1]);
  const entities = Object.values(report.stats);
  const changed = entities.reduce((n, e) => n + e.inserted + e.updated, 0);
  const unchanged = entities.reduce((n, e) => n + e.unchanged, 0);
  if (changed > 0) { console.error(`second run changed ${changed} rows`); process.exit(1); }
  console.log(`0 inserted, 0 updated, ${unchanged} unchanged`);
' "$PWD/$second_run") || fail "the backfill is not idempotent"
echo "$idempotency"

bold "Reconcile: the cutover gate"
pnpm -s reconcile || fail "reconciliation is not clean"

bold "API"
node_modules/.bin/tsx src/cli/serve.ts >reports/api.log 2>&1 &
started+=("$!")
api="http://${HOST:-127.0.0.1}:${PORT:-3000}"
wait_for "$api/health" 60 || fail "the API didn't start; see reports/api.log"

shadow=$(curl -s -o /dev/null -w '%{http_code} via %header{x-read-source}' \
  -H 'x-read-source: shadow' "$api/v1/bookings/bk_00042")
echo "GET /v1/bookings/bk_00042 (shadow): $shadow"
echo "shadow stats: $(curl -s "$api/debug/shadow-stats")"

echo "POST a lesson overlapping bk_overlap_a (instructor in_fx_01, 15 Sep 10:00–11:00):"
status=$(curl -s -o reports/demo-409.json -w '%{http_code}' -X POST "$api/v1/bookings" \
  -H 'content-type: application/json' \
  -d '{"studentId":"st_fx_09","instructorId":"in_fx_01","startsAt":"2026-09-15T10:30:00+02:00","durationMin":60}')
echo "  → $status $(cat reports/demo-409.json)"
[ "$status" = "409" ] || fail "expected 409 for an overlapping booking, got $status"

bold "Summary"
cat <<EOF
  ✔ schema migrated from zero (001–004)
  ✔ emulator seeded with messy data (known-bad fixtures included)
  ✔ backfill: $(node -e 'const r=require(process.argv[1]);const b=r.stats.bookings;console.log(`${b.inserted} bookings inserted, ${Object.values(b.rejected).reduce((a,c)=>a+c,0)} rejected with a reason`)' "$PWD/$first_run")
  ✔ second backfill: $idempotency
  ✔ reconciliation clean (exit 0)
  ✔ shadow read: $shadow
  ✔ overlapping booking refused: HTTP $status BOOKING_OVERLAP
  Reports: $first_run, $second_run
EOF
