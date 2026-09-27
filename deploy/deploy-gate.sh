#!/usr/bin/env bash
# Installed as /usr/local/bin/penge-deploy-gate and forced for the deploy key
# in ~penge-deploy/.ssh/authorized_keys: the key can upload a release into
# /opt/penge/releases (penge-receive) and activate one, and nothing else. No shell.
set -euo pipefail

cmd=${SSH_ORIGINAL_COMMAND:-}
case $cmd in
  "penge-activate "*)
    id=${cmd#penge-activate }
    [[ $id =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad release id" >&2; exit 2; }
    exec /usr/local/bin/penge-activate "$id"
    ;;
  "penge-receive "*)
    id=${cmd#penge-receive }
    [[ $id =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad release id" >&2; exit 2; }
    exec /usr/local/bin/penge-receive "$id"
    ;;
  *)
    echo "this key can only upload and activate releases" >&2
    exit 1
    ;;
esac
