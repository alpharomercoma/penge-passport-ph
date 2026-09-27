#!/usr/bin/env bash
# Runs Valkey (the open-source Redis, from Debian) on this server, reachable
# only from it, and points the app at it. provision.sh runs this; it is safe to
# run again. Run as root.
#
# Local rather than hosted: the password never crosses the internet, every API
# request skips a round trip, and there is no outside account to set up. The
# subscribers in it (addresses encrypted) are copied to R2 daily by the checker.
set -euo pipefail

ENV_FILE=/etc/penge/server.env
CONF=/etc/valkey/penge.conf
export DEBIAN_FRONTEND=noninteractive

apt-get install -y -qq --no-install-recommends valkey-server >/dev/null

if [[ ! -f $CONF ]]; then
  pass=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  install -o valkey -g valkey -m 0640 /dev/stdin "$CONF" <<CONF
# Written by setup-valkey.sh. Loopback only, with a password as well, and
# nothing evicted: a subscriber must never be dropped to make room.
bind 127.0.0.1 -::1
protected-mode yes
port 6379
requirepass $pass
appendonly yes
appendfsync everysec
maxmemory 64mb
maxmemory-policy noeviction
CONF
fi
# Later settings win, so the include goes last.
grep -qx "include $CONF" /etc/valkey/valkey.conf || printf '\ninclude %s\n' "$CONF" >> /etc/valkey/valkey.conf
systemctl enable valkey-server >/dev/null 2>&1
systemctl restart valkey-server

pass=$(sed -n 's/^requirepass //p' "$CONF")
for _ in 1 2 3 4 5; do
  REDISCLI_AUTH=$pass valkey-cli -h 127.0.0.1 ping 2>/dev/null | grep -qx PONG && break
  sleep 1
done
REDISCLI_AUTH=$pass valkey-cli -h 127.0.0.1 ping | grep -qx PONG || { echo "!! valkey does not answer" >&2; exit 1; }

if [[ -f $ENV_FILE ]]; then
  url="redis://default:$pass@127.0.0.1:6379"
  if grep -q '^REDIS_URL=' "$ENV_FILE"; then
    sed -i "s#^REDIS_URL=.*#REDIS_URL=$url#" "$ENV_FILE"
  else
    echo "REDIS_URL=$url" >> "$ENV_FILE"
  fi
  sed -i '/^ALLOW_PLAINTEXT_REDIS=/d' "$ENV_FILE"
fi
echo "== valkey answers on 127.0.0.1:6379 (password in $CONF)"
