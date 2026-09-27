#!/usr/bin/env bash
# Send-only mail for PengePassportPH: Postfix accepts mail from this machine
# only, and OpenDKIM signs every message for your domain. Nothing listens on
# the internet. Run as root on the server once you own a domain:
#
#   bash setup-mail.sh example.com
#
# Safe to run again: the DKIM key is kept. Prints the DNS records to add.
set -euo pipefail

DOMAIN=${1:?usage: setup-mail.sh <domain>}
[[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || {
  echo "give the domain in lower case, like example.com" >&2
  exit 2
}
MAILHOST=${MAILHOST:-mail.$DOMAIN}
# Where DMARC aggregate reports go (optional): an inbox you read, e.g. you@yourdomain.com.
DMARC_RUA=${DMARC_RUA:-}
SELECTOR=${SELECTOR:-penge}
IP=${PUBLIC_IP:-$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')}
KEYDIR=/etc/opendkim/keys/$DOMAIN

have_systemd() { [[ -d /run/systemd/system ]]; }

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
debconf-set-selections <<<"postfix postfix/main_mailer_type select Internet Site"
debconf-set-selections <<<"postfix postfix/mailname string $DOMAIN"
apt-get update -qq
apt-get install -y -qq --no-install-recommends postfix opendkim opendkim-tools openssl ca-certificates >/dev/null

echo "== DKIM key ($SELECTOR._domainkey.$DOMAIN)"
install -d -o opendkim -g opendkim -m 0750 "$KEYDIR"
if [[ ! -f $KEYDIR/$SELECTOR.private ]]; then
  opendkim-genkey -b 2048 -h sha256 -r -d "$DOMAIN" -s "$SELECTOR" -D "$KEYDIR"
fi
chown opendkim:opendkim "$KEYDIR"/*
chmod 0600 "$KEYDIR/$SELECTOR.private"

cat >/etc/opendkim.conf <<CONF
# Written by setup-mail.sh. Signs mail from this machine for $DOMAIN.
Syslog                  yes
SyslogSuccess           yes
UMask                   007
UserID                  opendkim
PidFile                 /run/opendkim/opendkim.pid
Mode                    s
Domain                  $DOMAIN
Selector                $SELECTOR
KeyFile                 $KEYDIR/$SELECTOR.private
Socket                  inet:8891@127.0.0.1
InternalHosts           127.0.0.1
Canonicalization        relaxed/simple
SignatureAlgorithm      rsa-sha256
# RFC 8058: one-click unsubscribe counts only when both List-Unsubscribe
# headers are signed. Oversigning stops anyone adding a second copy later.
SignHeaders             From,Reply-To,Subject,Date,To,Cc,Message-ID,MIME-Version,Content-Type,Content-Transfer-Encoding,List-Unsubscribe,List-Unsubscribe-Post,Feedback-ID,Auto-Submitted
OversignHeaders         From,Subject,List-Unsubscribe,List-Unsubscribe-Post
CONF

echo "== postfix (loopback only)"
postconf -e \
  "myhostname = $MAILHOST" \
  "myorigin = \$mydomain" \
  "mydomain = $DOMAIN" \
  "mydestination = localhost" \
  "inet_interfaces = loopback-only" \
  "inet_protocols = ipv4" \
  "mynetworks = 127.0.0.0/8" \
  "relayhost =" \
  "smtpd_banner = \$myhostname ESMTP" \
  "disable_vrfy_command = yes" \
  "smtpd_milters = inet:127.0.0.1:8891" \
  "non_smtpd_milters = \$smtpd_milters" \
  "milter_protocol = 6" \
  "milter_default_action = tempfail" \
  "smtp_tls_security_level = may" \
  "smtp_tls_loglevel = 1" \
  "maximal_queue_lifetime = 1d" \
  "bounce_queue_lifetime = 1d" \
  "default_destination_concurrency_limit = 4" \
  "smtpd_sender_restrictions = check_sender_access inline:{ alerts@$DOMAIN=OK }, reject" \
  "authorized_submit_users = root" \
  "smtpd_client_event_limit_exceptions =" \
  "smtpd_client_message_rate_limit = 150" \
  "maillog_file = /var/log/postfix/mail.log"
# Local processes other than the app cannot use this server as a relay: SMTP
# from any sender but alerts@ is refused, the sendmail command is root's only,
# and even the app is capped at 150 messages a minute.
echo "$DOMAIN" >/etc/mailname

# Delivery logs name recipients: keep them 3 days, in their own file, not the journal.
# Bounces (in root's mailbox) quote them too: keep those about two weeks.
install -d -m 0750 /var/log/postfix
cat >/etc/logrotate.d/penge-mail <<'ROTATE'
/var/log/postfix/mail.log {
  daily
  rotate 3
  missingok
  notifempty
  copytruncate
}
/var/mail/root {
  weekly
  rotate 1
  missingok
  notifempty
  copytruncate
}
ROTATE
# Remembered for check-mail-dns.sh.
install -d -m 0755 /etc/penge
printf 'MAIL_DOMAIN=%s\nMAILHOST=%s\nSELECTOR=%s\n' "$DOMAIN" "$MAILHOST" "$SELECTOR" >/etc/penge/mail.conf

# Bounces and postmaster mail come back to this machine and land in
# /var/mail/root, so failed deliveries can be read (see deploy/README.md).
cat >/etc/postfix/virtual <<VIRTUAL
alerts@$DOMAIN      root@localhost
postmaster@$DOMAIN  root@localhost
VIRTUAL
postmap /etc/postfix/virtual
postconf -e "virtual_alias_maps = hash:/etc/postfix/virtual"

if have_systemd; then
  systemctl enable --now opendkim postfix >/dev/null 2>&1
  systemctl restart opendkim
  systemctl restart postfix
else
  # Containers in tests: no systemd.
  install -d -o opendkim -g opendkim /run/opendkim
  pkill -x opendkim || true
  while pgrep -x opendkim >/dev/null; do sleep 0.2; done
  opendkim
  postfix stop >/dev/null 2>&1 || true
  postfix start >/dev/null 2>&1
fi

pubkey=$(tr -d '\n\t "()' <"$KEYDIR/$SELECTOR.txt" | sed -n 's/.*p=\([A-Za-z0-9+/=]*\).*/\1/p')

cat <<RECORDS

== Add these DNS records:

  $MAILHOST.  A    $IP
  $DOMAIN.  TXT  "v=spf1 ip4:$IP -all"
  $SELECTOR._domainkey.$DOMAIN.  TXT  "v=DKIM1; h=sha256; k=rsa; s=email; p=$pubkey"
  _dmarc.$DOMAIN.  TXT  "v=DMARC1; p=none; adkim=s; aspf=s${DMARC_RUA:+; rua=mailto:$DMARC_RUA}"
RECORDS
if [[ $MAILHOST != "$DOMAIN" ]]; then
  echo "  $DOMAIN.  A    $IP      (the website, if it is served from this server)"
fi
cat <<NEXT

Then ask RackNerd (support ticket) to set the reverse DNS (PTR) of $IP to
$MAILHOST. Check everything with: bash check-mail-dns.sh $DOMAIN
NEXT
