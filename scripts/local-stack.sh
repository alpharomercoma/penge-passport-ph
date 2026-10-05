#!/bin/sh
# The local push test stack: never touches .secrets/, R2, the DFA or the server.
#   scripts/local-stack.sh up | down
# It only ever starts, and stops, what it started itself: a container named
# penge-local-valkey on this machine's Docker, and the processes whose ids it
# keeps in .local/pids/. Anything else on those ports makes it refuse.
set -eu
cd "$(dirname "$0")/.."
repo=$PWD
pids="$repo/.local/pids"
PORTS="6391 8787 4173 8443"

# Docker on this machine only: a remote context or DOCKER_HOST would run (and stop) things
# elsewhere. The endpoint Docker would really use is found (DOCKER_CONTEXT wins over DOCKER_HOST,
# which wins over the current context), checked, and then every command is pinned to it.
local_docker() {
  if [ -n "${DOCKER_CONTEXT:-}" ]; then
    host=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || echo unknown)
  elif [ -n "${DOCKER_HOST:-}" ]; then
    host=$DOCKER_HOST
  else
    host=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || echo unknown)
  fi
  case "$host" in
  unix://*) ;;
  *)
    echo "local-stack: Docker points at $host, not this machine; refusing" >&2
    exit 1
    ;;
  esac
}
dk() { env -u DOCKER_CONTEXT DOCKER_HOST="$host" docker "$@"; }

# One process we started: its id is kept, with a word its command line must contain.
start() {
  name=$1 marker=$2 log=$3
  shift 3
  "$@" > "$log" 2>&1 &
  echo "$! $marker" > "$pids/$name.pid"
}

# Stops only processes this script started, and only while they are still what it started.
stop_owned() {
  [ -d "$pids" ] || return 0
  for file in "$pids"/*.pid; do
    [ -f "$file" ] || continue
    read -r pid marker < "$file" || true
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -qF -- "$marker"; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  done
}

# Waits up to 30 seconds in all; each probe brings its own timeout (curl --max-time).
wait_for() {
  what=$1
  shift
  until_s=$(($(date +%s) + 30))
  until "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$until_s" ]; then
      echo "local-stack: $what did not start (see .local/*.log)" >&2
      return 1
    fi
    sleep 0.2
  done
}

down() {
  stop_owned
  local_docker
  # Only our container, and only if it is the throwaway one we made.
  if dk inspect penge-local-valkey >/dev/null 2>&1; then dk stop penge-local-valkey >/dev/null 2>&1 || true; fi
}

case "${1:-}" in
up)
  local_docker
  mkdir -p .local/tls .local/mail "$pids"
  if ls "$pids"/*.pid >/dev/null 2>&1 || dk inspect penge-local-valkey >/dev/null 2>&1; then
    echo "local-stack: already up (or left over): run scripts/local-stack.sh down first" >&2
    exit 1
  fi
  for port in $PORTS; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "local-stack: port $port is in use; refusing to start over it" >&2
      exit 1
    fi
  done
  # From here, a failure takes down what was started.
  trap 'down' EXIT
  dk run -d --rm --name penge-local-valkey -p 127.0.0.1:6391:6379 valkey/valkey:8.1 >/dev/null
  wait_for valkey dk exec penge-local-valkey valkey-cli PING
  dk exec penge-local-valkey valkey-cli SET pp:test:disposable 1 >/dev/null
  if [ ! -f .local/tls/cert.pem ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
      -subj /CN=localhost -addext subjectAltName=DNS:localhost -keyout .local/tls/key.pem -out .local/tls/cert.pem 2>/dev/null
    chmod 600 .local/tls/key.pem
  fi
  BASE_PATH=pengepassportph VITE_LOCAL_DEBUG=1 npm run build -w @penge/web >/dev/null
  npm run dev:build -w @penge/server >/dev/null 2>&1
  # Started directly (not through npm or npx), so the ids kept are the servers themselves.
  PENGE_LOCAL_KV=redis://127.0.0.1:6391 PENGE_LOCAL_DIR="$repo/.local" \
    start api "$repo/.local/dist/local.mjs" .local/api.log node "$repo/.local/dist/local.mjs"
  (cd apps/web && BASE_PATH=pengepassportph start web "vite preview --host 127.0.0.1 --port 4173" ../../.local/web.log \
    ../../node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 --strictPort)
  start proxy apps/server/dev/https-proxy.mjs .local/proxy.log node apps/server/dev/https-proxy.mjs
  wait_for api curl -sf --max-time 2 http://127.0.0.1:8787/api/status
  wait_for web curl -sf --max-time 2 http://127.0.0.1:4173/pengepassportph/
  wait_for proxy curl -sfk --max-time 2 https://localhost:8443/pengepassportph/
  trap - EXIT
  echo "web   http://localhost:4173/pengepassportph/"
  echo "https https://localhost:8443/pengepassportph/   mail in .local/mail/"
  printf 'SPKI hash for Chrome: '
  openssl x509 -in .local/tls/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
  ;;
down)
  down
  ;;
*)
  echo "usage: scripts/local-stack.sh up|down" >&2
  exit 2
  ;;
esac
