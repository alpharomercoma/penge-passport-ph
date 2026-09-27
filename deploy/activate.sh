#!/usr/bin/env bash
# Installed on the server as /usr/local/bin/penge-activate; run by the deploy
# user (through penge-deploy-gate) after a release is uploaded to
# releases/<id>.partial. Publishes it, switches to it atomically, checks the
# API is ready, and switches back if it is not. One activation at a time.
set -euo pipefail

id=${1:?usage: penge-activate <release-id>}
[[ $id =~ ^[A-Za-z0-9._-]+$ && $id != *.partial ]] || { echo "bad release id" >&2; exit 2; }
cd /opt/penge

exec 9>/opt/penge/.activate.lock
flock -w 300 9 || { echo "another activation is still running" >&2; exit 1; }

if [[ -d releases/$id.partial ]]; then
  [[ ! -e releases/$id ]] || { echo "release $id already exists" >&2; exit 2; }
  mv "releases/$id.partial" "releases/$id"
fi
[[ -f releases/$id/server/server.mjs && -f releases/$id/server/check.mjs && -f releases/$id/web/index.html ]] || {
  echo "release $id is incomplete" >&2
  exit 2
}

switch_to() {
  ln -sfn "$1" current.new
  mv -T current.new current
  sudo /usr/bin/systemctl restart penge-api.service
}

ready() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 3 http://127.0.0.1:8787/api/ready >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

previous=$(readlink current 2>/dev/null || true)
switch_to "releases/$id"
if ! ready; then
  echo "!! release $id did not become ready" >&2
  if [[ -n $previous ]]; then
    switch_to "$previous"
    ready && echo "rolled back to $previous" >&2
  fi
  exit 1
fi
echo "live: $id"

# Keep the five newest releases, and always the live one.
live=$(readlink current)
find releases -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2- |
  while read -r old; do
    [[ $old == "$live" ]] || rm -rf -- "$old"
  done
