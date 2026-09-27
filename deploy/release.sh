#!/usr/bin/env bash
# Build a release and ship it to the server.
#
#   deploy/release.sh <ssh-host>                  build, then ship (by hand)
#   deploy/release.sh build <dir>                 build into <dir>/<id>; no credentials needed
#   deploy/release.sh ship <dir> <ssh-host>       upload the release in <dir> and activate it
#
# CI builds in one job and ships from another, so the deploy key never shares a
# job with `npm ci` or the build. Needs `npm ci` done before `build`.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH=${SSH:-ssh}

build() {
  local out=$1
  # shellcheck source-path=SCRIPTDIR source=site.conf
  . deploy/site.conf
  npm run build -w @penge/server >/dev/null 2>&1
  BASE_PATH=$BASE_PATH npm run build -w @penge/web >/dev/null 2>&1
  local rev id
  rev=$(git rev-parse --short=10 HEAD 2>/dev/null || echo local)
  id="$(date -u +%Y%m%dT%H%M%SZ)-$rev-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  mkdir -p "$out/$id/server" "$out/$id/web"
  cp apps/server/dist/*.mjs apps/server/dist/*.map "$out/$id/server/"
  cp -R apps/web/dist/. "$out/$id/web/"
  # World-readable, so the penge user and Caddy can read what the deploy user owns.
  # (Set here rather than with rsync --chmod, which macOS's openrsync lacks.)
  chmod -R u=rwX,go=rX "$out/$id"
  echo "$id"
}

ship() {
  local dir=$1 host=$2 id
  id=$(find "$dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | head -1)
  [[ $id =~ ^[A-Za-z0-9._-]+$ ]] || { echo "no release found in $dir" >&2; exit 2; }
  chmod -R u=rwX,go=rX "$dir/$id" # CI artifacts do not keep permissions
  # A plain gzipped tar over SSH works the same from macOS and Linux (no rsync
  # flavours involved); the server's gate hands it to penge-receive.
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$dir/$id" -cz . | $SSH "$host" penge-receive "$id"
  $SSH "$host" penge-activate "$id"
}

case ${1:-} in
  build) build "${2:?usage: release.sh build <dir>}" ;;
  ship) ship "${2:?usage: release.sh ship <dir> <ssh-host>}" "${3:?usage: release.sh ship <dir> <ssh-host>}" ;;
  "" | -h | --help) sed -n '2,10p' "$0"; exit 2 ;;
  *)
    stage=$(mktemp -d)
    trap 'rm -rf "$stage"' EXIT
    build "$stage" >/dev/null
    ship "$stage" "$1"
    ;;
esac
