#!/usr/bin/env bash
# SIGKILL a service (no graceful shutdown). Uses docker compose if the stack runs there.
set -euo pipefail
cd "$(dirname "$0")/.."
svc=${1:?usage: chaos-kill.sh <service>}
if command -v docker >/dev/null && docker compose ps --services --status running 2>/dev/null | grep -qx "$svc"; then docker compose kill "$svc"; else ./scripts/stack.sh kill "$svc"; fi
