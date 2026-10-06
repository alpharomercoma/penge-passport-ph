#!/bin/sh
# Deletes rollout backups in /root/penge-backups/ whose expiry time, written in
# their name as ...-expires-YYYYMMDDTHHMMSSZ (then nothing, or .json), has passed.
# penge-backup-expire.timer runs it hourly (and once on start if a run was missed
# while the server was down). Anything else is left alone: other names, folders,
# links. PENGE_BACKUP_DIR points it at another folder (the tests).
set -eu
dir=${PENGE_BACKUP_DIR:-/root/penge-backups}
now=$(date -u +%Y%m%d%H%M%S)
for f in "$dir"/*-expires-*; do
  # Only regular files, never a link or a folder.
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  rest=${f##*-expires-}
  case $rest in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.json) ;;
    *) continue ;;
  esac
  # Compared as numbers: YYYYMMDDHHMMSS.
  expires=$(printf '%s' "${rest%%Z*}" | tr -d 'T')
  if [ "$expires" -le "$now" ]; then rm -f -- "$f" || echo "could not delete $f" >&2; fi
done
exit 0
