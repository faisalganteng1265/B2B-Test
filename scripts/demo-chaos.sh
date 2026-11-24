#!/usr/bin/env bash
# Chaos demo: FAIL_RATE 0.5 + lost responses + duplicate/dropped callbacks on both mocks, then a
# burst of real deposits. Watch retries in the dashboard and the Restate UI (localhost:9070).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
H=(-H "x-admin-token: ${ADMIN_TOKEN:-dev-admin-token}" -H 'content-type: application/json')
curl -s "${H[@]}" -X POST localhost:4000/admin/chaos/mobee -d '{"FAIL_RATE":0.5,"FAIL_AFTER_RATE":0.15,"TIMEOUT_RATE":0.05,"LATENCY_MS_MAX":800}' >/dev/null
curl -s "${H[@]}" -X POST localhost:4000/admin/chaos/bifast -d '{"FAIL_RATE":0.5,"FAIL_AFTER_RATE":0.15,"DUPLICATE_CALLBACK_RATE":0.3,"DROP_CALLBACK_RATE":0.2}' >/dev/null
echo "chaos: Storm (50% failures, lost responses, duplicate & dropped callbacks)"
npx tsx scripts/burst.ts --count "${COUNT:-20}"
echo "now: dashboard → Deposits, open a row to see retried steps; then run: make invariants"
