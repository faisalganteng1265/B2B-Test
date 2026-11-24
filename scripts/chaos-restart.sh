#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
svc=${1:?usage: chaos-restart.sh <service>}
if command -v docker >/dev/null && docker compose ps --services 2>/dev/null | grep -qx "$svc"; then docker compose start "$svc"; else ./scripts/stack.sh start "$svc"; fi
