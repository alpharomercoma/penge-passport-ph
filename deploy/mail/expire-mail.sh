#!/usr/bin/env bash
# Deletes mail that has been in Postfix's queue for the given number of seconds
# or more. setup-mail.sh runs it as penge-mail-expire with 28 minutes: every
# minute (penge-mail-expire.timer), and before Postfix starts.
#
# Postfix's own limit (maximal_queue_lifetime) acts only when a try fails, and
# the gap between tries grows with the message's age (from 5 minutes to just
# over an hour): a message refused early waits for its next try, and if that
# one succeeds it goes out late. Gmail took 43 such messages between 30 and 56
# minutes after they were queued on 9 November 2026.
#
# A delivery already under way when its message is deleted still finishes.
# Deleted mail is not bounced; postsuper records each deletion in mail.log.
# Mail on hold is left alone: only a person puts it there. Queue IDs must not
# repeat (enable_long_queue_ids = yes), or an ID listed here could, by the time
# it is deleted, name a newer message.
set -euo pipefail

max_age=${1:?usage: penge-mail-expire <seconds>}
[[ $max_age =~ ^[0-9]+$ ]] || {
  echo "give the age in whole seconds" >&2
  exit 2
}

# One message a line, as JSON. With Postfix stopped (before it starts) postqueue
# reads the queue files directly. The time limits keep a stuck call from holding
# up Postfix's start or the next run.
ids=$(timeout 20 postqueue -j | python3 -c '
import json, sys, time
cutoff = time.time() - int(sys.argv[1])
for line in sys.stdin:
    m = json.loads(line)
    if m["queue_name"] in ("incoming", "active", "deferred") and m["arrival_time"] <= cutoff:
        print(m["queue_id"])
' "$max_age")

# Only when there is something to delete: postsuper logs every call.
[[ -z $ids ]] || timeout 20 postsuper -d - incoming active deferred <<<"$ids"
