#!/usr/bin/env bash
# Rewrites Valkey's append-only log, every hour (penge-valkey-compact.timer).
#
# The log records every write, deleted and expired data included, until it is
# rewritten, and Valkey rewrites it by itself only as it grows (past 64 MB, then
# at each doubling): an unsubscribed person's record or a day's expired visitor
# salt could otherwise stay in it for weeks. A rewrite keeps only what is in the
# database when it starts, and Valkey deletes the old log once the new one is in
# place (aof-disable-auto-gc is off). With this, nothing deleted stays in the log
# for more than an hour, which the privacy page counts on.
set -euo pipefail

pass=$(sed -n 's/^requirepass //p' /etc/valkey/penge.conf)
cli() { REDISCLI_AUTH=$pass valkey-cli -h 127.0.0.1 --no-auth-warning "$@"; }
field() { cli INFO persistence | tr -d '\r' | sed -n "s/^$1://p"; }

pong=$(cli PING 2>&1)
[[ $pong == PONG ]] || { echo "valkey does not answer: $pong" >&2; exit 1; }

# Waits for a rewrite that is running or waiting to start, 10 minutes at most.
settle() {
  for _ in $(seq 600); do
    [[ "$(field aof_rewrite_in_progress)" == 0 && "$(field aof_rewrite_scheduled)" == 0 ]] && return
    sleep 1
  done
  echo "a rewrite has not finished in 10 minutes" >&2
  exit 1
}

# One already running started from an older copy of the database: it doesn't
# count. Let it finish, then start one from now.
for _ in 1 2 3; do
  settle
  out=$(cli BGREWRITEAOF)
  case $out in
    *"rewriting started"* | *"rewriting scheduled"*)
      settle
      status=$(field aof_last_bgrewrite_status)
      [[ $status == ok ]] || { echo "the rewrite failed: $status" >&2; exit 1; }
      echo "log rewritten"
      exit 0
      ;;
    *"already in progress"*) ;;
    *) echo "valkey refused the rewrite: $out" >&2; exit 1 ;;
  esac
done
echo "another rewrite kept starting first" >&2
exit 1
