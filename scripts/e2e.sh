#!/usr/bin/env bash
# E2E on the running stack + REAL Base Sepolia: chaos on → burst N real deposits → wait until every
# new deposit is completed → invariants must pass.  Usage: COUNT=100 scripts/e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
COUNT=${COUNT:-100}
TIMEOUT=${TIMEOUT:-900}
q() { psql -h localhost -U postgres -d mopay -tAc "$1"; }
H=(-H "x-admin-token: ${ADMIN_TOKEN:-dev-admin-token}" -H 'content-type: application/json')
curl -sf "${H[@]}" -X POST localhost:4000/admin/chaos/exchange -d '{"FAIL_RATE":0.3,"FAIL_AFTER_RATE":0.05}' >/dev/null
curl -sf "${H[@]}" -X POST localhost:4000/admin/chaos/bifast -d '{"FAIL_RATE":0.3,"FAIL_AFTER_RATE":0.05,"DUPLICATE_CALLBACK_RATE":0.2,"DROP_CALLBACK_RATE":0.05}' >/dev/null
echo "chaos on: FAIL_RATE=0.3 on both mocks (+ lost responses, duplicate and dropped callbacks)"
base=$(q "select count(*) from deposits where status='completed'")
since=$(q "select now()")
npx tsx scripts/burst.ts --count "$COUNT"
t0=$(date +%s)
while :; do
  done_=$(q "select count(*) from deposits where status in ('completed','manual_review','orphaned','failed') and first_seen_at >= '$since'")
  seen=$(q "select count(*) from deposits where first_seen_at >= '$since'")
  printf "\r  %3s/%s seen · %3s finished · %4ss " "$seen" "$COUNT" "$done_" $(( $(date +%s) - t0 ))
  [ "$done_" -ge "$COUNT" ] && break
  [ $(( $(date +%s) - t0 )) -gt "$TIMEOUT" ] && { echo; echo "timeout"; exit 1; }
  sleep 3
done
echo
q "select status, count(*) from deposits where first_seen_at >= '$since' group by status"
npx tsx scripts/invariants.ts
