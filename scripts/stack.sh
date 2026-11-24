#!/usr/bin/env bash
# Native process manager for the Mopay prototype (no Docker needed).
#   scripts/stack.sh up | down | status | start <svc> | stop <svc> | kill <svc> | restart <svc> | logs <svc>
# Each service runs in its own process group (setsid) so `kill` is a real SIGKILL of the whole tree.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
set -a; [ -f .env ] && source .env; set +a
mkdir -p data/logs data/pids

SERVICES=(restate mobee-mock bifast-mock workflow indexer api dashboard)
declare -A CMD=(
  [restate]="env RESTATE_LOG_FILTER=warn,restate=info $ROOT/node_modules/.bin/restate-server --listen-mode tcp --base-dir $ROOT/data/restate --node-name mopay"
  [mobee-mock]="pnpm --filter @mopay/mobee-mock start"
  [bifast-mock]="pnpm --filter @mopay/bifast-mock start"
  [workflow]="pnpm --filter @mopay/workflow start"
  [indexer]="pnpm --filter @mopay/indexer start"
  [api]="pnpm --filter @mopay/api start"
  [dashboard]="pnpm --filter @mopay/dashboard ${DASHBOARD_MODE:-dev}"
)
declare -A HEALTH=(
  [restate]="http://localhost:9070/health"
  [mobee-mock]="http://localhost:4100/healthz"
  [bifast-mock]="http://localhost:4200/healthz"
  [workflow]="tcp:9080"
  [indexer]="http://localhost:4300/healthz"
  [api]="http://localhost:4000/healthz"
  [dashboard]="http://localhost:3000/"
)

pidof_svc() { [ -f "data/pids/$1.pid" ] && cat "data/pids/$1.pid"; }
alive() { local p; p=$(pidof_svc "$1") && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

healthy() {
  local h=${HEALTH[$1]}
  if [[ $h == tcp:* ]]; then (exec 3<>/dev/tcp/127.0.0.1/${h#tcp:}) 2>/dev/null; else curl -sf -o /dev/null --max-time 2 "$h"; fi
}

wait_healthy() {
  for _ in $(seq 1 ${2:-90}); do healthy "$1" && return 0; alive "$1" || { echo "  ✗ $1 exited — tail data/logs/$1.log:"; tail -20 "data/logs/$1.log"; return 1; }; sleep 1; done
  echo "  ✗ $1 not healthy in time"; return 1
}

start() {
  local s=$1
  if alive "$s"; then echo "  • $s already running (pid $(pidof_svc "$s"))"; return 0; fi
  setsid bash -c "exec ${CMD[$s]}" >> "data/logs/$s.log" 2>&1 < /dev/null &
  echo $! > "data/pids/$s.pid"
  printf "  ▸ %-12s starting (pid %s)… " "$s" "$!"
  wait_healthy "$s" && echo "healthy"
}

stop() { # graceful: SIGTERM, then SIGKILL after 10s
  local s=$1 p; p=$(pidof_svc "$s") || return 0
  if kill -0 "$p" 2>/dev/null; then
    kill -TERM -- "-$p" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$p" 2>/dev/null
    echo "  ■ $s stopped"
  fi
  rm -f "data/pids/$s.pid"
}

hardkill() { # chaos: SIGKILL the whole process group, no cleanup
  local s=$1 p; p=$(pidof_svc "$s") || { echo "$s not running"; return 0; }
  kill -KILL -- "-$p" 2>/dev/null && echo "  ☠ $s killed (SIGKILL, pid $p)"
  rm -f "data/pids/$s.pid"
}

up() {
  echo "Mopay prototype — starting native stack"
  pg_isready -q -h localhost || { echo "Postgres is not running on localhost:5432"; exit 1; }
  make -s db-create >/dev/null
  pnpm -s db:migrate >/dev/null && echo "  ✓ migrations applied"
  [ -f "deployments/$(node -e 'console.log(process.env.CHAIN==="base"?8453:84532)').json" ] || ./scripts/deploy.sh
  start restate || exit 1
  start mobee-mock || exit 1
  start bifast-mock || exit 1
  start workflow || exit 1
  pnpm -s --filter @mopay/workflow register && echo "  ✓ workflow registered with Restate"
  pnpm -s db:seed
  start indexer || exit 1
  start api || exit 1
  start dashboard || exit 1
  echo
  echo "  Dashboard   http://localhost:3000"
  echo "  API docs    http://localhost:4000/docs"
  echo "  Restate UI  http://localhost:9070"
  echo "  Indexer     http://localhost:4300/metrics"
}

down() { for ((i=${#SERVICES[@]}-1; i>=0; i--)); do stop "${SERVICES[$i]}"; done; }

status() {
  for s in "${SERVICES[@]}"; do
    if alive "$s"; then st="up (pid $(pidof_svc "$s"))"; healthy "$s" && st="$st, healthy" || st="$st, NOT healthy"; else st="down"; fi
    printf "  %-12s %s\n" "$s" "$st"
  done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  start) start "$2" ;;
  stop) stop "$2" ;;
  kill) hardkill "$2" ;;
  restart) stop "$2"; start "$2" ;;
  logs) tail -f "data/logs/$2.log" ;;
  *) echo "usage: $0 up|down|status|start|stop|kill|restart|logs [service]"; exit 1 ;;
esac
