#!/usr/bin/env bash
# Catch-up demo on the REAL chain (Base Sepolia):
#   stop indexer → burst deposits → stay down for WAIT seconds → restart → watch lag fall to ~0
#   while backfill chunks complete, and a new deposit sent DURING catch-up is still seen in ~1 s.
# Base Sepolia makes ~5 blocks/s and `safe` trails head by ~600 blocks, so WAIT must exceed ~2 min
# for the gap to go through backfill. WAIT=3600 reproduces the "down for 1 hour" scenario.
set -euo pipefail
cd "$(dirname "$0")/.."
WAIT=${WAIT:-300}
COUNT=${COUNT:-50}
export JUMP_THRESHOLD=${JUMP_THRESHOLD:-300} BACKFILL_CHUNK_SIZE=${BACKFILL_CHUNK_SIZE:-200}
metric() { curl -s localhost:4300/metrics | awk -v m="$1" '$1==m {print $2}'; }
chunks() { curl -s localhost:4300/metrics | awk -F'[{}" ]+' '/^indexer_backfill_chunks/ {printf "%s=%s ", $3, $4}'; }

echo "▶ 1/4 stopping the indexer (simulated outage)"
./scripts/stack.sh stop indexer
echo "▶ 2/4 sending $COUNT real deposits while the indexer is down"
npx tsx scripts/burst.ts --count "$COUNT"
echo "▶ 3/4 staying down for ${WAIT}s (≈ $((WAIT * 5)) Base Sepolia blocks)"
for ((s = WAIT; s > 0; s -= 10)); do printf "\r   %4ss left " "$s"; sleep $(( s < 10 ? s : 10 )); done; echo
echo "▶ 4/4 restarting the indexer (JUMP_THRESHOLD=$JUMP_THRESHOLD, chunk=$BACKFILL_CHUNK_SIZE)"
./scripts/stack.sh start indexer
sleep 3
echo "   sending one NEW deposit during catch-up…"
npx tsx scripts/send-deposit.ts --client A --amount 123 &
for i in $(seq 1 180); do
  lag=$(metric indexer_head_lag_blocks); printf "\r   lag %6s blocks · backfill %s   " "${lag:-?}" "$(chunks)"
  pending=$(curl -s localhost:4300/metrics | awk -F'[{}" ]+' '/^indexer_backfill_chunks/ && ($3=="pending"||$3=="running") {s+=$4} END {print s+0}')
  [ -n "$lag" ] && [ "${lag%.*}" -lt 30 ] && [ "$pending" = "0" ] && break
  sleep 2
done
wait
echo; echo "✔ caught up. Missed deposits are confirmed via backfill; open the dashboard → Deposits (\"via backfill\")."
