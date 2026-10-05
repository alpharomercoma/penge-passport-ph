#!/bin/sh
# Deletes rollout backups in /root/penge-backups/ whose expiry time, written in
# their name as ...-expires-YYYYMMDDTHHMMSSZ, has passed. penge-backup-expire.timer
# runs it hourly (and once on start if a run was missed while the server was down).
set -eu
now=$(date -u +%Y%m%dT%H%M%SZ)
for f in /root/penge-backups/*-expires-*; do
  [ -e "$f" ] || continue
  stamp=${f##*-expires-}
  stamp=${stamp%%.*}
  if [ "$stamp" \< "$now" ] || [ "$stamp" = "$now" ]; then rm -f -- "$f"; fi
done
exit 0
