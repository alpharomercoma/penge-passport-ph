#!/usr/bin/env bash
# The alerts redesign's rollout, from this Mac, one phase at a time (deploy/README.md, "Leaving the channel design
# (one maintenance window)"). Each phase checks what it expects, stops on anything else, and never runs the next one.
#
#   scripts/rollout-alerts.sh preflight          read only: this checkout, its tests, and the server's state
#   scripts/rollout-alerts.sh stage              build this commit and upload it, NOT activated (before the window)
#   scripts/rollout-alerts.sh stop               the window starts: no new check (waits for a running one), API stopped
#   scripts/rollout-alerts.sh inspect            read only: what the channel release left (the staged release's command)
#   scripts/rollout-alerts.sh backup             server.env, the subscribers, and the channel keys if any; each checked
#   scripts/rollout-alerts.sh clean --yes        only if inspect found anything (it stops for the owner on email off)
#   scripts/rollout-alerts.sh configure [--memory-128]
#                                                server.env: PUSH_MODE=off, PUSH_OWNER_EMAILS removed, a new
#                                                PUSH_OWNER_TOKEN (written to /root/penge-owner-link.txt, never shown)
#   scripts/rollout-alerts.sh activate           switch to the staged release, run one check, the timer back on
#   scripts/rollout-alerts.sh owner              after a healthy check on the new release: PUSH_MODE=owner
#   scripts/rollout-alerts.sh abort              before activate: back to the release before, as it was, and running
#   scripts/rollout-alerts.sh publish            after the window: main moved to this commit and pushed (CI then
#                                                deploys the same code again, a normal deploy)
#
# The server is reached as root with your usual key (ssh-agent); the upload goes through the deploy user's gate with
# .secrets/deploy_key, as deploy/release.sh does. What the phases learn (the release id, the backups made) is kept on
# the server in /root/penge-rollout.state. Nothing here prints a secret: REDIS_URL, keys and the owner token stay in
# files on the server.
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

# Runs a script on the server as root. Its first lines are the shared helpers below; arguments follow.
remote() {
  local body=$1
  shift
  "${ROOT[@]}" bash -s -- "$@" <<REMOTE
set -euo pipefail
STATE=/root/penge-rollout.state
die() { printf '!! %s\n' "\$*" >&2; exit 1; }
state() { grep -E "^\$1=" "\$STATE" 2>/dev/null | tail -1 | cut -d= -f2-; }
setstate() { printf '%s=%s\n' "\$1" "\$2" >> "\$STATE"; chmod 0600 "\$STATE"; }
# Valkey through the penge user and its server.env (REDIS_URL is never printed).
vk() { sudo -u penge sh -c 'set -a; . /etc/penge/server.env; exec valkey-cli -u "\$REDIS_URL" --no-auth-warning "\$@"' sh "\$@"; }
# A command of the staged (or a given) release's admin.mjs, as the penge user with the server's environment.
admin() { local dir=\$1; shift; sudo -u penge sh -c 'set -a; . /etc/penge/server.env; exec /usr/local/bin/node --enable-source-maps "\$0/admin.mjs" "\$@"' "\$dir" "\$@"; }
staged() { local id; id=\$(state release); [ -n "\$id" ] || die "nothing staged (run: stage)"; printf '%s' "\$id"; }
stagedDir() { local id; id=\$(staged); if [ -d "/opt/penge/releases/\$id.partial" ]; then printf '%s' "/opt/penge/releases/\$id.partial/server"; elif [ -d "/opt/penge/releases/\$id" ]; then printf '%s' "/opt/penge/releases/\$id/server"; else die "release \$id is not on the server"; fi; }
stopped() { [ "\$(systemctl is-active penge-api || true)" != active ] || die "penge-api is running: run stop first"; [ "\$(systemctl is-active penge-check.timer || true)" != active ] || die "penge-check.timer is on: run stop first"; local s; s=\$(systemctl show -p ActiveState --value penge-check.service); [ "\$s" = inactive ] || [ "\$s" = failed ] || die "a check is running (\$s)"; }
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
    case $cur in *-'"$OLD_COMMIT"'-*) ;; *) echo "!! not the release this rollout starts from ('"$OLD_COMMIT"')";; esac
    echo "PUSH_MODE=$(grep -E "^PUSH_MODE=" /etc/penge/server.env | cut -d= -f2)"
    grep -q "^PUSH_OWNER_EMAILS=" /etc/penge/server.env && echo "PUSH_OWNER_EMAILS: set (configure removes it)" || echo "PUSH_OWNER_EMAILS: not set"
    grep -q "^PUSH_OWNER_TOKEN=" /etc/penge/server.env && echo "PUSH_OWNER_TOKEN: already set" || true
    echo "penge-api: $(systemctl is-active penge-api || true); penge-check.timer: $(systemctl is-active penge-check.timer || true)"
    echo "valkey: $(vk INFO memory | grep -E "^(used_memory_human|maxmemory_human):" | tr "\r\n" "  ")"
    echo "subscribers: $(vk SCARD pp:subs)"
    free -m | awk "/^Mem:/ {print \"RAM: \" \$2 \" MB, available \" \$7 \" MB\"}"
    df -h / | awk "NR==2 {print \"disk: \" \$4 \" free\"}"
    [ -d /root/penge-backups ] && echo "backups folder: present" || echo "backups folder: missing (backup creates it)"
    systemctl is-enabled penge-backup-expire.timer >/dev/null 2>&1 && echo "backup expiry: on" || echo "!! backup expiry timer is off (deploy/README.md, Rollout backups)"
    [ -f "$STATE" ] && { echo "rollout state from an earlier run:"; cat "$STATE"; } || true
  '
  ;;

stage)
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes: commit them first"
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
    setstate release "$1"
    echo "staged: /opt/penge/releases/$1.partial (current is still $(readlink /opt/penge/current))"
  ' "$id"
  ;;

stop)
  say "The window starts: no new check; a running one finishes (up to its 20-minute lock); the API stops"
  remote '
    systemctl disable --now penge-check.timer
    for _ in $(seq 1 300); do s=$(systemctl show -p ActiveState --value penge-check.service); [ "$s" = inactive ] || [ "$s" = failed ] && break; sleep 5; done
    s=$(systemctl show -p ActiveState --value penge-check.service)
    [ "$s" = inactive ] || [ "$s" = failed ] || die "the check is still $s after 25 minutes: look at journalctl -u penge-check"
    echo "last check: $(systemctl show -p Result --value penge-check.service)"
    systemctl stop penge-api
    stopped
    setstate stopped "$(date -u +%Y%m%dT%H%M%SZ)"
    echo "stopped: no checker, no API (the site shows that dates cannot be loaded)"
  '
  ;;

inspect)
  say "What the channel release left (read only)"
  remote '
    stopped
    out=$(admin "$(stagedDir)" channel-inspect)
    printf "%s\n" "$out" > /root/penge-rollout-inspect.json; chmod 0600 /root/penge-rollout-inspect.json
    /usr/local/bin/node -e "
      const i = JSON.parse(require(\"fs\").readFileSync(\"/root/penge-rollout-inspect.json\", \"utf8\"));
      const n = i.pushKeys.length + i.reservedKeys.length + i.subscribers.length + i.pending.length + (i.pendingChannels ? 1 : 0);
      console.log(JSON.stringify({ pushKeys: i.pushKeys.length, reservedKeys: i.reservedKeys.length, subscribersWithChannels: i.subscribers.length, pendingWithChannels: i.pending.length, pendingChannels: i.pendingChannels, stops: i.stops }));
      console.log(n === 0 && i.stops.length === 0 ? \"found nothing: clean is not needed\" : i.stops.length ? \"STOPS: the owner decides before clean (see /root/penge-rollout-inspect.json)\" : \"found channel data: back up, then clean --yes\");
    "
  '
  ;;

backup)
  say "Backups into /root/penge-backups (14 days)"
  remote '
    stopped
    install -d -m 0700 /root/penge-backups
    now=$(date -u +%Y%m%dT%H%M%SZ); exp=$(date -u -d "+14 days" +%Y%m%dT%H%M%SZ)
    env=/root/penge-backups/server.env-$now-expires-$exp
    subs=/root/penge-backups/subscribers-$now-expires-$exp.json
    install -m 0600 /etc/penge/server.env "$env"
    # The subscriber export with the CURRENT release, which runs with the current configuration.
    admin /opt/penge/current/server backup > "$subs"; chmod 0600 "$subs"
    test -s "$env" || die "the server.env backup is empty"
    test -s "$subs" || die "the subscriber export is empty"
    count=$(/usr/local/bin/node -e "const d = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); console.log((d.subscribers ?? []).length)" "$subs") || die "the subscriber export is not readable JSON"
    live=$(vk SCARD pp:subs)
    echo "subscribers: $count in the export, $live in the list of all subscribers"
    # The export also takes subscribers reachable only through an office: never fewer than the list.
    [ "$count" -ge "$live" ] || die "the export holds fewer subscribers than the list"
    setstate env_backup "$env"; setstate subs_backup "$subs"
    # The channel keys, only if inspect found anything.
    if /usr/local/bin/node -e "const i = JSON.parse(require(\"fs\").readFileSync(\"/root/penge-rollout-inspect.json\", \"utf8\")); process.exit(i.pushKeys.length + i.reservedKeys.length + i.subscribers.length + i.pending.length + (i.pendingChannels ? 1 : 0) > 0 ? 0 : 1)"; then
      keys=/root/penge-backups/channel-keys-$now-expires-$exp.json
      admin "$(stagedDir)" channel-dump > "$keys"; chmod 0600 "$keys"
      /usr/local/bin/node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"))" "$keys" || die "the channel key dump is not readable JSON"
      setstate keys_backup "$keys"
      echo "channel keys: $(wc -c < "$keys") bytes"
    else
      echo "channel keys: none to back up"
    fi
    ls -l /root/penge-backups/*-"$now"-*
  '
  ;;

clean)
  [ "${1:-}" = --yes ] || die "clean changes data: run it as: clean --yes (only if inspect found anything)"
  remote '
    stopped
    [ -n "$(state subs_backup)" ] || die "no backup made in this window (run backup first)"
    admin "$(stagedDir)" channel-clean --yes
    echo "and again, expecting nothing:"
    admin "$(stagedDir)" channel-inspect | /usr/local/bin/node -e "let t=\"\"; process.stdin.on(\"data\", (c) => (t += c)).on(\"end\", () => { const i = JSON.parse(t); const n = i.pushKeys.length + i.reservedKeys.length + i.subscribers.length + i.pending.length + (i.pendingChannels ? 1 : 0); console.log(n === 0 ? \"clean: nothing left\" : \"!! still found \" + n); process.exit(n === 0 ? 0 : 1); })"
  '
  ;;

configure)
  memory=no
  [ "${1:-}" = --memory-128 ] && memory=yes
  say "server.env for the new release (a backup of it was made by backup)"
  remote '
    stopped
    [ -n "$(state env_backup)" ] || die "no server.env backup made in this window (run backup first)"
    f=/etc/penge/server.env; tmp=$(mktemp /etc/penge/.server.env.XXXXXX)
    # PUSH_MODE=off; PUSH_OWNER_EMAILS out; a new PUSH_OWNER_TOKEN unless one is there; the device limits left to memory.
    grep -vE "^(PUSH_MODE|PUSH_OWNER_EMAILS)=" "$f" > "$tmp"
    printf "PUSH_MODE=off\n" >> "$tmp"
    if ! grep -q "^PUSH_OWNER_TOKEN=" "$tmp"; then
      token=$(openssl rand -base64 33 | tr "+/" "-_" | tr -d "=\n")
      [ ${#token} -ge 32 ] || die "could not make a token"
      printf "PUSH_OWNER_TOKEN=%s\n" "$token" >> "$tmp"
      umask 077; printf "https://alphaexperiments.com/pengepassportph/#owner=%s\n" "$token" > /root/penge-owner-link.txt
      echo "owner link written to /root/penge-owner-link.txt (root only)"
    fi
    chown --reference="$f" "$tmp"; chmod --reference="$f" "$tmp"; mv "$tmp" "$f"
    echo "server.env: PUSH_MODE=$(grep -E "^PUSH_MODE=" "$f" | cut -d= -f2); PUSH_OWNER_EMAILS $(grep -q "^PUSH_OWNER_EMAILS=" "$f" && echo still set || echo removed); PUSH_OWNER_TOKEN $(grep -q "^PUSH_OWNER_TOKEN=" "$f" && echo set || echo missing)"
    if [ "$1" = yes ]; then
      avail=$(free -m | awk "/^Mem:/ {print \$7}")
      # A fork for a snapshot or rewrite can need up to twice the data: keep maxmemory under half of what is free.
      [ "$avail" -ge 300 ] || die "only $avail MB available: not raising maxmemory"
      sed -i "s/^maxmemory 64mb$/maxmemory 128mb/" /etc/valkey/penge.conf
      grep -qx "maxmemory 128mb" /etc/valkey/penge.conf || die "penge.conf has no maxmemory 64mb line to raise"
      vk CONFIG SET maxmemory 128mb >/dev/null
      echo "valkey: $(vk CONFIG GET maxmemory | tail -1) bytes (and 128mb in penge.conf)"
    fi
    setstate configured "$(date -u +%Y%m%dT%H%M%SZ)"
  ' "$memory"
  ;;

activate)
  say "Switching to the staged release"
  remote '
    stopped
    [ -n "$(state configured)" ] || die "server.env not configured in this window (run configure first)"
    id=$(staged)
    if ! penge-activate "$id"; then
      # penge-activate switched back to the release before; it starts with this server.env too. Email goes on.
      systemctl enable --now penge-check.timer
      die "the release did not become ready; current is $(readlink /opt/penge/current); the timer is back on (email goes on). PUSH_MODE stays off."
    fi
    [ "$(readlink /opt/penge/current)" = "releases/$id" ] || die "current is $(readlink /opt/penge/current), not $id"
    curl -fsS --max-time 5 http://127.0.0.1:8787/api/status | /usr/local/bin/node -e "let t=\"\"; process.stdin.on(\"data\", (c) => (t += c)).on(\"end\", () => console.log(\"status: push \" + JSON.parse(t).push))"
    echo "one check now (it waits for the run):"
    systemctl start penge-check.service || true
    r=$(systemctl show -p Result --value penge-check.service)
    echo "check result: $r"
    journalctl -u penge-check -n 15 --no-pager | cut -c1-220
    systemctl enable --now penge-check.timer
    setstate activated "$id"; setstate check "$r"
    [ "$r" = success ] && echo "healthy: run owner next" || echo "!! the check was not healthy: read the journal; owner waits for a healthy one (the timer is on, email goes on)"
  '
  ;;

owner)
  remote '
    id=$(state activated); [ -n "$id" ] || die "not activated (run activate first)"
    [ "$(readlink /opt/penge/current)" = "releases/$id" ] || die "current is not the activated release"
    r=$(systemctl show -p Result --value penge-check.service)
    [ "$r" = success ] || die "the last check was $r: wait for a healthy one (journalctl -u penge-check)"
    f=/etc/penge/server.env
    sed -i "s/^PUSH_MODE=off$/PUSH_MODE=owner/" "$f"
    grep -qx "PUSH_MODE=owner" "$f" || die "PUSH_MODE is not off here; nothing changed"
    systemctl restart penge-api
    for _ in $(seq 1 30); do curl -fsS --max-time 3 http://127.0.0.1:8787/api/ready >/dev/null 2>&1 && break; sleep 0.5; done
    mode=$(curl -fsS --max-time 5 http://127.0.0.1:8787/api/status | /usr/local/bin/node -e "let t=\"\"; process.stdin.on(\"data\", (c) => (t += c)).on(\"end\", () => console.log(JSON.parse(t).push))")
    [ "$mode" = owner ] || die "status says push $mode"
    setstate owner "$(date -u +%Y%m%dT%H%M%SZ)"
    echo "owner mode on. Your link: ssh root@'"$HOST"' cat /root/penge-owner-link.txt (open it once per browser or app)"
  '
  ;;

abort)
  say "Back to the release before, as it was"
  remote '
    [ -z "$(state activated)" ] || die "already activated: roll back as deploy/README.md says, not with abort"
    env=$(state env_backup)
    if [ -n "$env" ] && [ -f "$env" ]; then
      install -m 0640 -o root -g penge "$env" /etc/penge/server.env
      echo "server.env restored from $env"
    fi
    if grep -qx "maxmemory 128mb" /etc/valkey/penge.conf && [ -n "$(state configured)" ]; then echo "(Valkey keeps 128mb: harmless; set it back by hand if wanted)"; fi
    systemctl start penge-api
    systemctl enable --now penge-check.timer
    echo "running: $(readlink /opt/penge/current), penge-api $(systemctl is-active penge-api), timer $(systemctl is-active penge-check.timer)"
    mv "$STATE" "$STATE.aborted-$(date -u +%Y%m%dT%H%M%SZ)"
  '
  ;;

publish)
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes"
  remote '[ -n "$(state owner)" ] || [ -n "$(state activated)" ] || die "not activated yet: publish comes after the window"'
  head=$(git rev-parse HEAD)
  git fetch origin main
  git merge-base --is-ancestor origin/main "$head" || die "origin/main is not an ancestor of this commit: merge by hand"
  say "Pushing: main → $(git rev-parse --short "$head") (CI then deploys it: the same code, a normal deploy)"
  git push origin "$head:refs/heads/main"
  git push origin "HEAD:refs/heads/$(git rev-parse --abbrev-ref HEAD)"
  ;;

*)
  sed -n '2,22p' "$0"
  exit 2
  ;;
esac
