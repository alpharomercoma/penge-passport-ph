#!/usr/bin/env bash
# The alerts redesign's rollout, from this Mac, one phase at a time (deploy/README.md, "Leaving the channel design
# (one maintenance window)"). The phases run in this order only; each checks the state the one before left, and
# none runs the next:
#
#   scripts/rollout-alerts.sh preflight          read only: this checkout, its tests, and the server's state
#   scripts/rollout-alerts.sh stage              build this commit and upload it, NOT activated (before the window)
#   scripts/rollout-alerts.sh stop               the window starts: a copy of server.env kept as it was; no new check
#                                                (waits for a running one); the API stopped
#   scripts/rollout-alerts.sh inspect            read only: what the channel release left (the staged release's command)
#   scripts/rollout-alerts.sh backup             the subscribers (every one checked by id) and the channel keys if any
#   scripts/rollout-alerts.sh clean --yes        only if inspect found anything, with no stop for the owner
#   scripts/rollout-alerts.sh configure [--memory-128]
#                                                server.env: PUSH_MODE=off, PUSH_OWNER_EMAILS removed, a
#                                                PUSH_OWNER_TOKEN (in /root/penge-owner-link.txt, never shown)
#   scripts/rollout-alerts.sh activate           switch to the staged release, the timer back on, one check
#   scripts/rollout-alerts.sh check              one more check on the new release (if activate's was not healthy)
#   scripts/rollout-alerts.sh owner              after a healthy check on the new release: PUSH_MODE=owner
#   scripts/rollout-alerts.sh publish            after owner: main moved to exactly the staged commit, and pushed
#   scripts/rollout-alerts.sh abort              before activate: the release before, with its server.env, running
#
# The server is reached as root with your usual key (ssh-agent); the upload goes through the deploy user's gate with
# .secrets/deploy_key, as deploy/release.sh does. The rollout's state is kept on the server, in
# /root/penge-rollout.state, and every phase holds /root/penge-rollout.lock while it runs. Nothing here prints a
# secret: REDIS_URL, the keys and the owner token stay in files on the server.

# The phases' remote bodies are single-quoted on purpose: they expand on the server, not here.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=213.250.173.234
OLD_COMMIT=05cee09186
ROOT=(ssh -o BatchMode=yes -o ConnectTimeout=15 "root@$HOST")
DEPLOY=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o IdentitiesOnly=yes -i .secrets/deploy_key -o UserKnownHostsFile=.secrets/deploy_known_hosts "penge-deploy@$HOST")

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# Runs a script on the server as root, under the rollout's lock, after the shared helpers; arguments follow.
remote() {
  local body=$1
  shift
  "${ROOT[@]}" bash -s -- "$@" <<REMOTE
set -euo pipefail
exec 9>/root/penge-rollout.lock
flock -n 9 || { echo "!! another phase is running" >&2; exit 1; }
STATE=/root/penge-rollout.state
OLD_COMMIT=$OLD_COMMIT
die() { printf '!! %s\n' "\$*" >&2; exit 1; }
state() { grep -E "^\$1=" "\$STATE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
setstate() { touch "\$STATE"; chmod 0600 "\$STATE"; printf '%s=%s\n' "\$1" "\$2" >> "\$STATE"; }
phase() { state phase; }
need() { local p; p=\$(phase); for want in "\$@"; do [ "\$p" = "\$want" ] && return 0; done; die "this phase follows: \$* (the rollout is at: \${p:-nothing})"; }
# Valkey through the penge user and its server.env (REDIS_URL is never printed); -e: an error is a failure.
vk() { sudo -u penge sh -c 'set -a; . /etc/penge/server.env; exec valkey-cli -e -u "\$REDIS_URL" --no-auth-warning "\$@"' sh "\$@"; }
# A command of a release's admin.mjs, as the penge user with the server's environment.
admin() { local dir=\$1; shift; sudo -u penge sh -c 'set -a; . /etc/penge/server.env; exec /usr/local/bin/node --enable-source-maps "\$0/admin.mjs" "\$@"' "\$dir" "\$@"; }
stagedDir() { local id; id=\$(state release); [ -n "\$id" ] || die "nothing staged"; if [ -d "/opt/penge/releases/\$id.partial" ]; then printf '%s' "/opt/penge/releases/\$id.partial/server"; elif [ -d "/opt/penge/releases/\$id" ]; then printf '%s' "/opt/penge/releases/\$id/server"; else die "release \$id is not on the server"; fi; }
stopped() { [ "\$(systemctl is-active penge-api || true)" != active ] || die "penge-api is running"; [ "\$(systemctl is-active penge-check.timer || true)" != active ] || die "penge-check.timer is on"; local s; s=\$(systemctl show -p ActiveState --value penge-check.service); [ "\$s" = inactive ] || [ "\$s" = failed ] || die "a check is running (\$s)"; }
ready() { for _ in \$(seq 1 40); do curl -fsS --max-time 3 http://127.0.0.1:8787/api/ready >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
pushMode() { curl -fsS --max-time 5 http://127.0.0.1:8787/api/status | /usr/local/bin/node -e 'let t=""; process.stdin.on("data", (c) => (t += c)).on("end", () => console.log(JSON.parse(t).push))'; }
# An inspection's summary, strictly: "<found> <stops>", or a failure if it is not a whole inspection.
summary() { /usr/local/bin/node -e '
  const i = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const k of ["pushKeys", "reservedKeys", "subscribers", "pending", "livePending", "stops"]) if (!Array.isArray(i[k])) throw new Error("no " + k);
  if (typeof i.pendingChannels !== "boolean") throw new Error("no pendingChannels");
  console.log((i.pushKeys.length + i.reservedKeys.length + i.subscribers.length + i.pending.length + (i.pendingChannels ? 1 : 0)) + " " + i.stops.length);
' "\$1"; }
# Sets one line of server.env (or removes it, with no value), atomically, keeping its owner and mode.
envset() {
  local f=/etc/penge/server.env tmp rc=0
  tmp=\$(mktemp /etc/penge/.server.env.XXXXXX)
  # grep: 0 lines kept, 1 none kept; anything else (a read or write error) leaves server.env as it is.
  grep -vE "^\$1=" "\$f" > "\$tmp" || rc=\$?
  [ "\$rc" -le 1 ] || { rm -f "\$tmp"; die "could not rewrite server.env (grep \$rc)"; }
  if [ "\$#" -ge 2 ]; then printf '%s=%s\n' "\$1" "\$2" >> "\$tmp" || { rm -f "\$tmp"; die "could not write server.env"; }; fi
  # Every other line kept: the keys above all.
  [ "\$(grep -cvE "^\$1=" "\$f" || true)" = "\$(grep -cvE "^\$1=" "\$tmp" || true)" ] || { rm -f "\$tmp"; die "server.env rewrite lost lines"; }
  grep -q "^EMAIL_ENC_KEY=" "\$tmp" || { rm -f "\$tmp"; die "server.env rewrite lost EMAIL_ENC_KEY"; }
  chown --reference="\$f" "\$tmp"; chmod --reference="\$f" "\$tmp"; sync -f "\$tmp" 2>/dev/null || true; mv "\$tmp" "\$f"
}
envget() { grep -E "^\$1=" /etc/penge/server.env | tail -1 | cut -d= -f2- || true; }
timerOn() { systemctl enable --now penge-check.timer && [ "\$(systemctl is-active penge-check.timer)" = active ]; }
# Back to the original release, running: switched, verified, restarted; prints what it managed.
restoreOrig() {
  local orig; orig=\$(state orig_release)
  [ -d "/opt/penge/\$orig" ] || { echo "!! \$orig is gone from the server"; return 1; }
  if [ "\$(readlink /opt/penge/current)" != "\$orig" ]; then ln -sfn "\$orig" /opt/penge/current.new && mv -T /opt/penge/current.new /opt/penge/current || { echo "!! could not switch current back"; return 1; }; fi
  [ "\$(readlink /opt/penge/current)" = "\$orig" ] || { echo "!! current is \$(readlink /opt/penge/current)"; return 1; }
  systemctl restart penge-api || true
  ready || { echo "!! penge-api is not ready on \$orig"; return 1; }
  timerOn || { echo "!! the timer did not start"; return 1; }
  echo "back on \$orig, penge-api ready, the timer on"
}
tokenOk() { [[ \$(envget PUSH_OWNER_TOKEN) =~ ^[A-Za-z0-9_-]{32,256}\$ ]]; }
# One check on what is current, now; prints its run id if it finished healthy (not skipped), and fails otherwise.
oneCheck() {
  systemctl start penge-check.service || true
  local inv; inv=\$(systemctl show -p InvocationID --value penge-check.service)
  journalctl _SYSTEMD_INVOCATION_ID="\$inv" -o cat --no-pager | /usr/local/bin/node -e '
    let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => {
      const done = t.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l && l.msg === "check finished").pop();
      if (!done) { console.error("no finished check in this run"); process.exit(1); }
      console.error("check: healthy " + done.healthy + ", skipped " + done.skipped + ", problems " + JSON.stringify(done.problems ?? []).slice(0, 300));
      if (done.healthy !== true || done.skipped !== null) process.exit(1);
      console.log(done.runId);
    });'
}
$body
REMOTE
}

phase=${1:-}
shift || true
case $phase in
preflight)
  say "This checkout"
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes: commit them first"
  echo "branch $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD)"
  [ -f .secrets/deploy_key ] && [ -f .secrets/deploy_known_hosts ] || die ".secrets/deploy_key or deploy_known_hosts missing"
  say "Tests (this takes a minute)"
  if ! npm run typecheck >/dev/null || ! npm test >/dev/null 2>&1; then die "typecheck or tests failed: run npm test"; fi
  echo "typecheck and tests pass"
  say "The server (read only)"
  remote '
    cur=$(readlink /opt/penge/current); echo "current: $cur"
    case $cur in *-"$OLD_COMMIT"-*) ;; *) echo "!! not the release this rollout starts from ($OLD_COMMIT)";; esac
    echo "PUSH_MODE=$(envget PUSH_MODE)"
    if [ -n "$(envget PUSH_OWNER_EMAILS)" ]; then echo "PUSH_OWNER_EMAILS: set (configure removes it)"; else echo "PUSH_OWNER_EMAILS: not set"; fi
    if [ -n "$(envget PUSH_OWNER_TOKEN)" ]; then if tokenOk; then echo "PUSH_OWNER_TOKEN: set, well formed"; else echo "!! PUSH_OWNER_TOKEN is set but malformed (configure replaces it)"; fi; fi
    echo "penge-api: $(systemctl is-active penge-api || true); penge-check.timer: $(systemctl is-active penge-check.timer || true)"
    echo "valkey: $(vk INFO memory | grep -E "^(used_memory_human|maxmemory_human):" | tr "\r\n" "  ")"
    echo "subscribers: $(vk SCARD pp:subs)"
    free -m | awk "/^Mem:/ {print \"RAM: \" \$2 \" MB, available \" \$7 \" MB\"}"
    df -h / | awk "NR==2 {print \"disk: \" \$4 \" free\"}"
    if [ -d /root/penge-backups ]; then echo "backups folder: present"; else echo "backups folder: missing (stop creates it)"; fi
    if systemctl is-enabled penge-backup-expire.timer >/dev/null 2>&1; then echo "backup expiry: on"; else echo "!! backup expiry timer is off (deploy/README.md, Rollout backups)"; fi
    if [ -f "$STATE" ]; then echo "a rollout in progress, at: $(phase)"; else echo "no rollout in progress"; fi
  '
  ;;

stage)
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes: commit them first"
  sha=$(git rev-parse HEAD)
  remote '
    p=$(phase)
    [ -z "$p" ] || [ "$p" = staged ] || die "a rollout is at $p: finish it, or abort it first"
    case $(readlink /opt/penge/current) in *-"$OLD_COMMIT"-*) ;; *) die "current is not the release this rollout starts from";; esac
  '
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  say "Building $(git rev-parse --short HEAD)"
  id=$(deploy/release.sh build "$dir" | tail -1)
  [[ $id =~ ^[A-Za-z0-9._-]+$ ]] || die "the build gave no release id"
  for need in web/index.html web/sw.js web/manifest.webmanifest web/.well-known/assetlinks.json server/server.mjs server/check.mjs server/admin.mjs; do
    [ -f "$dir/$id/$need" ] || die "the release has no $need"
  done
  say "Uploading $id (not activated)"
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$dir/$id" -cz . | "${DEPLOY[@]}" penge-receive "$id"
  remote '
    [ -f "/opt/penge/releases/$1.partial/server/admin.mjs" ] || die "the upload is not on the server"
    # Rechecked under this lock: another phase may have run while this one built and uploaded.
    p=$(phase)
    [ -z "$p" ] || [ "$p" = staged ] || { rm -rf "/opt/penge/releases/$1.partial"; die "the rollout moved on to $p meanwhile; this upload is removed"; }
    case $(readlink /opt/penge/current) in *-"$OLD_COMMIT"-*) ;; *) rm -rf "/opt/penge/releases/$1.partial"; die "current changed meanwhile";; esac
    # A re-stage starts the rollout again, and removes the upload it replaces (so penge-activate never prunes the
    # original release to keep the five newest).
    prev=$(state release)
    if [ -n "$prev" ] && [ "$prev" != "$1" ] && [ -d "/opt/penge/releases/$prev.partial" ]; then rm -rf "/opt/penge/releases/$prev.partial"; fi
    rm -f "$STATE"
    setstate rollout "$(date -u +%Y%m%dT%H%M%SZ)"
    setstate orig_release "$(readlink /opt/penge/current)"
    setstate release "$1"
    setstate sha "$2"
    setstate phase staged
    echo "staged: /opt/penge/releases/$1.partial; current is still $(state orig_release)"
  ' "$id" "$sha"
  ;;

stop)
  say "The window starts: server.env kept as it was; no new check; a running one finishes; the API stops"
  remote '
    need staged
    install -d -m 0700 /root/penge-backups
    if [ -z "$(state orig_env)" ]; then
      exp=$(date -u -d "+14 days" +%Y%m%dT%H%M%SZ)
      env=/root/penge-backups/server.env-$(state rollout)-expires-$exp
      install -m 0600 /etc/penge/server.env "$env"
      test -s "$env" || die "the server.env copy is empty"
      setstate orig_env "$env"
    fi
    systemctl disable --now penge-check.timer
    for _ in $(seq 1 300); do s=$(systemctl show -p ActiveState --value penge-check.service); { [ "$s" = inactive ] || [ "$s" = failed ]; } && break; sleep 5; done
    s=$(systemctl show -p ActiveState --value penge-check.service)
    [ "$s" = inactive ] || [ "$s" = failed ] || die "the check is still $s after 25 minutes: journalctl -u penge-check (the timer stays off; abort turns it back on)"
    systemctl stop penge-api
    stopped
    setstate phase stopped
    echo "stopped: no checker, no API (the site says dates cannot be loaded). server.env as it was: $(state orig_env)"
  '
  ;;

inspect)
  say "What the channel release left (read only)"
  remote '
    need stopped inspected
    stopped
    admin "$(stagedDir)" channel-inspect > /root/penge-rollout-inspect.json || die "channel-inspect failed"
    chmod 0600 /root/penge-rollout-inspect.json
    sum=$(summary /root/penge-rollout-inspect.json) || die "the inspection is not readable"
    found=${sum% *}; stops=${sum#* }
    setstate found "$found"; setstate stops "$stops"; setstate phase inspected
    echo "found: $found channel records; stops for the owner: $stops"
    if [ "$stops" != 0 ]; then echo "STOPS (the owner decides; nothing may be cleaned until then):"; /usr/local/bin/node -e "console.log(JSON.parse(require(\"fs\").readFileSync(\"/root/penge-rollout-inspect.json\", \"utf8\")).stops.join(\"\n\"))"; fi
    if [ "$found" = 0 ]; then echo "nothing to clean: back up, then configure"; else echo "back up, then clean --yes"; fi
  '
  ;;

backup)
  say "The subscribers, every one checked by id, and the channel keys if any"
  remote '
    need inspected
    stopped
    exp=$(date -u -d "+14 days" +%Y%m%dT%H%M%SZ); r=$(state rollout)
    subs=/root/penge-backups/subscribers-$r-expires-$exp.json
    # With the CURRENT release, which runs with the current configuration.
    admin /opt/penge/current/server backup > "$subs" || die "the subscriber export failed"
    chmod 0600 "$subs"
    # Every subscriber with a record that the list or an office set names must be in it.
    { vk SMEMBERS pp:subs; for k in $(vk --scan --pattern "pp:site:*:subs"); do vk SMEMBERS "$k"; done; } | sort -u > /root/penge-rollout-listed
    vk --scan --pattern "pp:sub:*" | sed "s/^pp:sub://" | sort -u > /root/penge-rollout-hashes
    comm -12 /root/penge-rollout-listed /root/penge-rollout-hashes > /root/penge-rollout-expected
    /usr/local/bin/node -e "
      const fs = require(\"fs\");
      const d = JSON.parse(fs.readFileSync(process.argv[1], \"utf8\"));
      if (d.version !== 2 || !Array.isArray(d.subscribers)) throw new Error(\"not a version 2 export\");
      for (const s of d.subscribers) if (typeof s.id !== \"string\" || !s.fields || typeof s.fields.email !== \"string\") throw new Error(\"a damaged entry\");
      const have = new Set(d.subscribers.map((s) => s.id));
      const want = fs.readFileSync(process.argv[2], \"utf8\").split(\"\n\").filter(Boolean);
      const missing = want.filter((id) => !have.has(id));
      console.log(\"subscribers: \" + have.size + \" exported, \" + want.length + \" expected, \" + missing.length + \" missing\");
      if (missing.length) process.exit(1);
    " "$subs" /root/penge-rollout-expected || die "the export does not hold every subscriber"
    rm -f /root/penge-rollout-listed /root/penge-rollout-hashes /root/penge-rollout-expected
    keys=""
    if [ "$(state found)" != 0 ]; then
      keys=/root/penge-backups/channel-keys-$r-expires-$exp.json
      admin "$(stagedDir)" channel-dump > "$keys" || die "the channel key dump failed"
      chmod 0600 "$keys"
      /usr/local/bin/node -e "const d = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); if (!Object.keys(d).length) throw new Error(\"empty\")" "$keys" || die "the channel key dump is not readable, or empty"
      echo "channel keys: $(wc -c < "$keys") bytes"
    fi
    setstate subs_backup "$subs"
    if [ -n "$keys" ]; then setstate keys_backup "$keys"; fi
    setstate phase backed_up
    ls -l "$(state orig_env)" "$subs" ${keys:+"$keys"}
  '
  ;;

clean)
  [ "${1:-}" = --yes ] || die "clean changes data: run it as: clean --yes"
  remote '
    need backed_up
    stopped
    [ "$(state found)" != 0 ] || die "inspect found nothing: there is nothing to clean (configure next)"
    [ "$(state stops)" = 0 ] || die "the inspection has stops: the owner decides first"
    for f in "$(state subs_backup)" "$(state keys_backup)"; do [ -s "$f" ] || die "a backup of this window is missing: $f"; done
    admin "$(stagedDir)" channel-clean --yes || die "channel-clean failed or refused"
    admin "$(stagedDir)" channel-inspect > /root/penge-rollout-after.json || die "channel-inspect failed"
    # Nothing left but reservations a kept pending request still needs, and no stop.
    /usr/local/bin/node -e "
      const i = JSON.parse(require(\"fs\").readFileSync(\"/root/penge-rollout-after.json\", \"utf8\"));
      const needed = new Set(i.livePending.map((p) => \"pp:reserved:\" + p.index));
      const left = [...i.pushKeys, ...i.subscribers.map((s) => s.id), ...i.pending.map((p) => p.key), ...(i.pendingChannels ? [\"pp:pending:channels\"] : []), ...i.reservedKeys.filter((k) => !needed.has(k))];
      console.log(left.length || i.stops.length ? \"!! left: \" + JSON.stringify(left) + \", stops: \" + JSON.stringify(i.stops) : \"clean: nothing left\");
      process.exit(left.length || i.stops.length ? 1 : 0);
    " || die "the clean left something"
    setstate phase cleaned
  '
  ;;

configure)
  memory=no
  [ "${1:-}" = --memory-128 ] && memory=yes
  say "server.env for the new release"
  remote '
    p=$(phase)
    if [ "$p" = backed_up ]; then
      { [ "$(state found)" = 0 ] && [ "$(state stops)" = 0 ]; } || die "inspect found channel data or stops: clean (or the owner) first"
    else
      need cleaned configured
    fi
    stopped
    envset PUSH_OWNER_EMAILS
    envset PUSH_MODE off
    if ! tokenOk; then
      token=$(openssl rand -base64 33 | tr "+/" "-_" | tr -d "=\n")
      [[ $token =~ ^[A-Za-z0-9_-]{32,256}$ ]] || die "could not make a token"
      envset PUSH_OWNER_TOKEN "$token"
    fi
    ( umask 077; printf "https://alphaexperiments.com/pengepassportph/#owner=%s\n" "$(envget PUSH_OWNER_TOKEN)" > /root/penge-owner-link.txt )
    tokenOk || die "PUSH_OWNER_TOKEN is not well formed"
    { [ "$(envget PUSH_MODE)" = off ] && [ -z "$(envget PUSH_OWNER_EMAILS)" ]; } || die "server.env did not take the changes"
    echo "server.env: PUSH_MODE=off; PUSH_OWNER_EMAILS removed; PUSH_OWNER_TOKEN set (owner link in /root/penge-owner-link.txt)"
    if [ "$1" = yes ]; then
      avail=$(free -m | awk "/^Mem:/ {print \$7}")
      # A fork for a snapshot or rewrite can need up to twice the data: keep maxmemory under half of what is free.
      [ "$avail" -ge 300 ] || die "only $avail MB available: not raising maxmemory"
      grep -qxE "maxmemory (64|128)mb" /etc/valkey/penge.conf || die "penge.conf has no maxmemory line to raise"
      vk CONFIG SET maxmemory 128mb >/dev/null || die "Valkey refused CONFIG SET maxmemory"
      [ "$(vk CONFIG GET maxmemory | tail -1)" = 134217728 ] || die "Valkey did not take maxmemory 128mb"
      sed -i "s/^maxmemory 64mb$/maxmemory 128mb/" /etc/valkey/penge.conf
      grep -qx "maxmemory 128mb" /etc/valkey/penge.conf || die "penge.conf was not updated (Valkey runs with 128mb until it restarts)"
      echo "valkey: maxmemory 128mb, now and in penge.conf"
    fi
    setstate phase configured
  ' "$memory"
  ;;

activate)
  say "Switching to the staged release"
  remote '
    need configured activated
    id=$(state release); orig=$(state orig_release)
    if [ "$(phase)" = configured ] && [ "$(readlink /opt/penge/current)" != "releases/$id" ]; then
      stopped
      # The original release must survive penge-activate'"'"'s pruning (it keeps the five newest): no other upload waits.
      others=$(find /opt/penge/releases -mindepth 1 -maxdepth 1 -type d -name "*.partial" ! -name "$id.partial" | wc -l)
      [ "$others" = 0 ] || die "other uploads wait in /opt/penge/releases (*.partial): remove them first"
      [ -d "/opt/penge/$orig" ] || die "$orig is not on the server"
      if penge-activate "$id"; then ok=yes; else ok=no; fi
    else
      # Switched already (an earlier run stopped after the switch): carried on from here, never switched back.
      [ "$(readlink /opt/penge/current)" = "releases/$id" ] || die "the rollout is at $(phase), but current is $(readlink /opt/penge/current): by hand (deploy/README.md)"
      ok=yes
    fi
    if [ "$ok" = yes ] && [ "$(readlink /opt/penge/current)" = "releases/$id" ] && ready; then
      # Email goes on before anything else: the timer first, then the record.
      timerOn || die "live on $id, but the timer did not start: run activate again"
      setstate phase activated
      echo "live: $id; status: push $(pushMode); the timer is on"
      if run=$(oneCheck); then setstate check_ok "$run"; echo "healthy: run owner next"; else echo "!! not a healthy check: read journalctl -u penge-check; then: check"; fi
      exit 0
    fi
    # Not live: the release before back, verified and running, whatever penge-activate managed.
    if restoreOrig; then die "the release did not become ready; the release before runs again (with PUSH_MODE=off) and email goes on. journalctl -u penge-api; abort restores server.env as it was."; fi
    die "the release did not become ready, and the release before could not be restored: deploy/README.md, by hand"
  '
  ;;

check)
  remote '
    need activated
    [ "$(readlink /opt/penge/current)" = "releases/$(state release)" ] || die "current is not the staged release"
    [ "$(systemctl is-active penge-check.timer)" = active ] || die "the timer is off: run activate again"
    if run=$(oneCheck); then setstate check_ok "$run"; echo "healthy: run owner next"; else die "not a healthy check: journalctl -u penge-check"; fi
  '
  ;;

owner)
  remote '
    need activated
    [ "$(readlink /opt/penge/current)" = "releases/$(state release)" ] || die "current is not the staged release"
    [ -n "$(state check_ok)" ] || die "no healthy check on the new release yet (run: check)"
    [ "$(systemctl is-active penge-check.timer)" = active ] || die "the timer is off: run activate again"
    tokenOk || die "PUSH_OWNER_TOKEN is not well formed"
    envset PUSH_MODE owner
    if systemctl restart penge-api && ready && [ "$(pushMode)" = owner ]; then
      setstate phase owner
      echo "owner mode on. Your link: ssh root@'"$HOST"' cat /root/penge-owner-link.txt (open it once per browser or app)"
      exit 0
    fi
    envset PUSH_MODE off
    systemctl restart penge-api || true
    if ready; then die "owner mode did not start; back to PUSH_MODE=off, running (journalctl -u penge-api)"; fi
    die "owner mode did not start, and penge-api is down with PUSH_MODE=off (journalctl -u penge-api)"
  '
  ;;

publish)
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes"
  out=$(remote '
    need owner
    [ "$(readlink /opt/penge/current)" = "releases/$(state release)" ] || die "current is not the rolled-out release"
    [ "$(systemctl is-active penge-check.timer)" = active ] || die "the timer is off"
    ready || die "penge-api is not ready"
    state sha
  ')
  sha=$(printf '%s\n' "$out" | tail -1)
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "no staged commit recorded"
  [ "$(git rev-parse HEAD)" = "$sha" ] || die "this checkout is at $(git rev-parse --short HEAD), not the rolled-out $(git rev-parse --short "$sha")"
  git fetch origin main
  git merge-base --is-ancestor origin/main "$sha" || die "origin/main is not an ancestor of the rolled-out commit: merge by hand"
  say "Pushing: main → ${sha:0:10} (CI then deploys it: the same code, a normal deploy)"
  git push origin "$sha:refs/heads/main"
  git push origin "$sha:refs/heads/$(git rev-parse --abbrev-ref HEAD)"
  ;;

abort)
  say "Back to the release before, with its server.env, running"
  remote '
    p=$(phase)
    case $p in staged|stopped|inspected|backed_up|cleaned|configured) ;; *) die "the rollout is at ${p:-nothing}: after activate, roll back as deploy/README.md says";; esac
    orig=$(state orig_release)
    [ "$(readlink /opt/penge/current)" = "$orig" ] || die "current is $(readlink /opt/penge/current), not $orig: restore by hand (deploy/README.md)"
    env=$(state orig_env)
    if [ -n "$env" ]; then
      [ -s "$env" ] || die "the server.env copy $env is missing"
      tmp=$(mktemp /etc/penge/.server.env.XXXXXX); cp "$env" "$tmp"; chown --reference=/etc/penge/server.env "$tmp"; chmod --reference=/etc/penge/server.env "$tmp"; mv "$tmp" /etc/penge/server.env
      echo "server.env restored from $env"
    fi
    if [ "$p" = cleaned ] || [ "$p" = configured ]; then echo "(if clean ran, the channel data it removed is in $(state keys_backup))"; fi
    if grep -qx "maxmemory 128mb" /etc/valkey/penge.conf; then echo "(Valkey keeps maxmemory 128mb: harmless)"; fi
    systemctl restart penge-api || true
    ready || die "penge-api did not become ready on $orig (journalctl -u penge-api); the timer stays off"
    timerOn || die "penge-api runs on $orig, but the timer did not start"
    mv "$STATE" "$STATE.aborted-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "running: $orig, penge-api ready, timer on"
  '
  ;;

*)
  sed -n '2,24p' "$0"
  exit 2
  ;;
esac
