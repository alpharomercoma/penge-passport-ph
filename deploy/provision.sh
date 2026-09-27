#!/usr/bin/env bash
# Prepares a Debian 13 server for PengePassportPH. Run as root on the server;
# safe to run again (it converges, it does not duplicate).
#
#   DEPLOY_PUBKEY="ssh-ed25519 AAAA… deploy" bash provision.sh
#
# Expects this directory's site.conf, systemd/ and caddy/ next to it, and the
# secrets in /etc/penge/server.env (see server.env.example). It writes only
# PUBLIC_BASE_URL, which follows site.conf, and REDIS_URL, for the Valkey it
# sets up on this server.
set -euo pipefail

NODE_MAJOR=${NODE_MAJOR:-24}
CADDY_KEY_FINGERPRINT=65760C51EDEA2017CEA2CA15155B6D79CA56EA34
DEPLOY_PUBKEY=${DEPLOY_PUBKEY:?set DEPLOY_PUBKEY to the deploy key public half}
HERE=$(cd "$(dirname "$0")" && pwd)

# Where the site is served: SITE_ADDRESS, BASE_PATH, PATH_ALIASES, REDIRECT_FROM.
# shellcheck source-path=SCRIPTDIR source=site.conf
. "$HERE/site.conf"
PATH_ALIASES=${PATH_ALIASES:-}
REDIRECT_FROM=${REDIRECT_FROM:-}

[[ $SITE_ADDRESS =~ ^[A-Za-z0-9.-]+$ ]] || { echo "SITE_ADDRESS must be a bare host name" >&2; exit 2; }
[[ $BASE_PATH =~ ^/[a-z0-9-]+$ ]] || { echo "BASE_PATH must look like /name" >&2; exit 2; }
for alias_path in $PATH_ALIASES; do
  [[ $alias_path =~ ^/[a-z0-9-]+$ && $alias_path != "$BASE_PATH" ]] || { echo "PATH_ALIASES must look like /name" >&2; exit 2; }
done
for old_host in $REDIRECT_FROM; do
  [[ $old_host =~ ^[A-Za-z0-9.-]+$ ]] || { echo "REDIRECT_FROM must be bare host names" >&2; exit 2; }
done
[[ $DEPLOY_PUBKEY =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [[:print:]]*)?$ && $DEPLOY_PUBKEY != *$'\n'* ]] ||
  { echo "DEPLOY_PUBKEY must be one ssh-ed25519 key" >&2; exit 2; }

export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gpg gpgv rsync sudo ufw xz-utils \
  unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https >/dev/null

echo "== ssh and firewall"
install -o root -g root -m 0644 /dev/stdin /etc/ssh/sshd_config.d/10-penge-hardening.conf <<'SSHD'
# Written by provision.sh: keys only.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
X11Forwarding no
SSHD
sshd -t && systemctl reload ssh
ufw limit 22/tcp comment 'SSH (rate-limited)' >/dev/null
ufw allow 80/tcp comment 'HTTP (redirects to HTTPS, ACME)' >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
ufw allow 443/udp comment 'HTTP/3' >/dev/null
ufw --force enable >/dev/null

# Logs hold visitors' IP addresses (Caddy errors) and, once mail is live, recipients
# (Postfix, which setup-mail.sh keeps separately for 3 days): two weeks at most.
install -d -m 0755 /etc/systemd/journald.conf.d
install -o root -g root -m 0644 /dev/stdin /etc/systemd/journald.conf.d/penge.conf <<'JOURNAL'
[Journal]
MaxRetentionSec=14day
JOURNAL
systemctl restart systemd-journald

echo "== automatic security updates (Debian, and Caddy's repository)"
install -o root -g root -m 0644 /dev/stdin /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
install -o root -g root -m 0644 /dev/stdin /etc/apt/apt.conf.d/52penge-unattended <<'APT'
Unattended-Upgrade::Origins-Pattern:: "origin=cloudsmith/caddy/stable";
// Kernel and libc fixes need a restart: 04:30 in Manila, when few people book.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "20:30";
APT

echo "== node v$NODE_MAJOR (signature-verified, updated weekly)"
install -d -m 0755 /usr/local/share/penge
install -o root -g root -m 0644 "$HERE/keys/nodejs-release-keys.kbx" /usr/local/share/penge/nodejs-release-keys.kbx
install -o root -g root -m 0755 "$HERE/node-install.sh" /usr/local/bin/penge-node-install
/usr/local/bin/penge-node-install "$NODE_MAJOR"

echo "== caddy"
if ! command -v caddy >/dev/null; then
  key=$(mktemp)
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key > "$key"
  # The key must be the one Caddy has signed with since 2016, whatever the download served.
  gpg --show-keys --with-colons "$key" | grep -q "^fpr:::::::::$CADDY_KEY_FINGERPRINT:" ||
    { echo "!! Caddy's signing key does not match $CADDY_KEY_FINGERPRINT" >&2; exit 1; }
  gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg < "$key"
  rm -f "$key"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
caddy version
# Only the capability to bind ports 80 and 443 (the packaged unit also grants CAP_NET_ADMIN),
# and a private directory for the admin socket.
install -d -m 0755 /etc/systemd/system/caddy.service.d
install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/caddy.service.d/penge.conf <<'UNIT'
[Service]
AmbientCapabilities=
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750
UNIT

echo "== users and directories"
id penge >/dev/null 2>&1 || useradd --system --home-dir /var/lib/penge --shell /usr/sbin/nologin penge
id penge-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash penge-deploy
install -d -o penge -g penge -m 0750 /var/lib/penge /var/lib/penge/limiter /var/lib/penge/spool
install -d -o penge-deploy -g penge-deploy -m 0755 /opt/penge /opt/penge/releases
install -d -o root -g penge -m 0750 /etc/penge
if [[ -f /etc/penge/server.env ]]; then
  chown root:penge /etc/penge/server.env && chmod 0640 /etc/penge/server.env
else
  echo "!! /etc/penge/server.env is missing: copy it before starting the services" >&2
fi

# The deploy key may upload a release and activate it, nothing more: its
# commands are forced through penge-deploy-gate (no shell, no port forwarding).
install -o root -g root -m 0755 "$HERE/deploy-gate.sh" /usr/local/bin/penge-deploy-gate
install -o root -g root -m 0755 "$HERE/receive.sh" /usr/local/bin/penge-receive
install -d -o penge-deploy -g penge-deploy -m 0700 /home/penge-deploy/.ssh
echo "command=\"/usr/local/bin/penge-deploy-gate\",restrict $DEPLOY_PUBKEY" > /home/penge-deploy/.ssh/authorized_keys
chown penge-deploy:penge-deploy /home/penge-deploy/.ssh/authorized_keys
chmod 0600 /home/penge-deploy/.ssh/authorized_keys
install -o root -g root -m 0755 "$HERE/activate.sh" /usr/local/bin/penge-activate
cat > /etc/sudoers.d/penge-deploy.tmp <<'SUDO'
penge-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart penge-api.service, /usr/bin/systemctl start --no-block penge-check.service
SUDO
visudo -cqf /etc/sudoers.d/penge-deploy.tmp
chmod 0440 /etc/sudoers.d/penge-deploy.tmp && mv /etc/sudoers.d/penge-deploy.tmp /etc/sudoers.d/penge-deploy

echo "== valkey (Redis), on this server only"
bash "$HERE/setup-valkey.sh"

echo "== systemd"
install -o root -g root -m 0644 "$HERE"/systemd/penge-*.service "$HERE"/systemd/penge-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable penge-api.service penge-check.timer penge-node-update.timer >/dev/null
systemctl start penge-node-update.timer

echo "== caddy config for https://$SITE_ADDRESS$BASE_PATH"
aliases=""
for alias_path in $PATH_ALIASES; do
  aliases+=$'\t'"redir $alias_path $BASE_PATH/ 308"$'\n\t'"redir $alias_path/* $BASE_PATH/ 308"$'\n'
done
awk -v site="$SITE_ADDRESS" -v base="$BASE_PATH" -v aliases="$aliases" '
  /^__PATH_ALIASES__$/ { printf "%s", aliases; next }
  { gsub(/__SITE_ADDRESS__/, site); gsub(/__BASE_PATH__/, base); print }
' "$HERE/caddy/Caddyfile.template" > /etc/caddy/Caddyfile.new
for old_host in $REDIRECT_FROM; do
  printf '\n%s {\n\tredir https://%s%s{uri} 308\n}\n' "$old_host" "$SITE_ADDRESS" "$BASE_PATH" >> /etc/caddy/Caddyfile.new
done
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null 2>&1 ||
  { caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new; exit 1; }
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
# A changed unit (capabilities, runtime directory) needs a restart, not a reload.
systemctl restart caddy

# Links in emails follow the site's address.
if [[ -f /etc/penge/server.env ]]; then
  url="https://$SITE_ADDRESS$BASE_PATH"
  if grep -q '^PUBLIC_BASE_URL=' /etc/penge/server.env; then
    sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$url#" /etc/penge/server.env
  else
    echo "PUBLIC_BASE_URL=$url" >> /etc/penge/server.env
  fi
fi

if [[ -L /opt/penge/current ]]; then
  systemctl restart penge-api.service
  systemctl start penge-check.timer
  echo "== running: $(readlink /opt/penge/current)"
else
  echo "== provisioned; no release yet: run deploy/release.sh from your machine or CI"
fi
