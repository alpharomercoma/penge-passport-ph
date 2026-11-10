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
# A re-run keeps the public address given the first time.
[[ -z ${PUBLIC_IP:-} && -r /etc/penge/mail.conf ]] && PUBLIC_IP=$(sed -n 's/^PUBLIC_IP=//p' /etc/penge/mail.conf)
IP=${PUBLIC_IP:-$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')}
# Behind 1:1 NAT (Huawei, AWS, Google…) the interface holds a private address,
# not the one the world sees: then PUBLIC_IP must say which that is.
if [[ $IP =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; then
  echo "!! $IP is a private address: run again with PUBLIC_IP=<this server's public IPv4>" >&2
  exit 2
fi
KEYDIR=/etc/opendkim/keys/$DOMAIN

have_systemd() { [[ -d /run/systemd/system ]]; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
debconf-set-selections <<<"postfix postfix/main_mailer_type select Internet Site"
debconf-set-selections <<<"postfix postfix/mailname string $DOMAIN"
apt-get update -qq
apt-get install -y -qq --no-install-recommends postfix opendkim opendkim-tools openssl ca-certificates python3 >/dev/null

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
  "smtp_tls_connection_reuse = yes" \
  "maximal_queue_lifetime = 30m" \
  "bounce_queue_lifetime = 30m" \
  "default_destination_concurrency_limit = 4" \
  "smtp_destination_concurrency_limit = 1" \
  "enable_long_queue_ids = yes" \
  "smtpd_sender_restrictions = check_sender_access inline:{ alerts@$DOMAIN=OK }, reject" \
  "authorized_submit_users = root" \
  "smtpd_client_event_limit_exceptions =" \
  "smtpd_client_message_rate_limit = 150" \
  "maillog_file = /var/log/postfix/mail.log"
# Local processes other than the app cannot use this server as a relay: SMTP
# from any sender but alerts@ is refused, the sendmail command is root's only,
# and even the app is capped at 150 messages a minute.
# Mail queued 28 minutes or more is deleted (penge-mail-expire, below): every
# minute, and before Postfix starts. Postfix's own lifetime acts only at a failed
# try, and the gap between tries grows with the message's age, so a message
# refused early could otherwise go out much later; if the job fails, the lifetime
# still drops mail at its next failed try. A later alert says dates are open that
# may have gone. It applies to all mail, so confirmation and deletion emails get
# the same 30 minutes. Long queue IDs do not repeat while the clock runs forward,
# so the job deleting by ID does not hit a newer message.
# One connection per receiving domain is what Gmail asks of a sender it
# rate-limits (421 4.7.28), and enough for this volume everywhere else.
# A cached connection carries the next message to the same domain instead of a
# new one being opened for each: without smtp_tls_connection_reuse, encrypted
# connections are never reused, and Gmail mail spent about 1.3 s of every 2.3 s
# opening one (measured 9 November 2026), so a run's burst waited minutes in line.
# tlsproxy holds the encrypted sessions for reuse. After a refusal (421) Gmail
# closes the connection, so the next message needs a new one.
postconf -Me "tlsproxy/unix = tlsproxy unix - - y - 0 tlsproxy"
echo "$DOMAIN" >/etc/mailname

# Delivery logs name recipients: keep them 3 days, in their own file, not the journal.
# Bounces (in root's mailbox) quote them too: the same 3 days.
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
  # /var/mail is group-writable (mail), which logrotate refuses without this.
  su root mail
  daily
  rotate 3
  missingok
  notifempty
  copytruncate
}
ROTATE
# Remembered for check-mail-dns.sh. (provision.sh owns /etc/penge and its 0750 mode.)
[[ -d /etc/penge ]] || install -d -m 0755 /etc/penge
printf 'MAIL_DOMAIN=%s\nMAILHOST=%s\nSELECTOR=%s\nPUBLIC_IP=%s\n' "$DOMAIN" "$MAILHOST" "$SELECTOR" "$IP" >/etc/penge/mail.conf

# Bounces and postmaster mail come back to this machine and land in
# /var/mail/root, so failed deliveries can be read (see deploy/README.md).
cat >/etc/postfix/virtual <<VIRTUAL
alerts@$DOMAIN      root@localhost
postmaster@$DOMAIN  root@localhost
VIRTUAL
postmap /etc/postfix/virtual
postconf -e "virtual_alias_maps = hash:/etc/postfix/virtual"

if have_systemd; then
  # Every minute, and before every start of Postfix (at boot, or after it was
  # stopped), so it cannot first deliver what went stale meanwhile. 1680 s is 28
  # minutes: a message is deleted before it is 29 minutes old, which leaves the
  # 30-minute limit a minute for a slow run. A failed run does not stop Postfix
  # starting ("-"); "+" is as for `postfix check`. The timer starts only after
  # Postfix has restarted with long queue IDs.
  install -o root -g root -m 0755 "$HERE/expire-mail.sh" /usr/local/bin/penge-mail-expire
  install -d -m 0755 /etc/systemd/system/postfix.service.d
  cat >/etc/systemd/system/postfix.service.d/penge-mail-expire.conf <<'UNIT'
[Service]
ExecStartPre=-+/usr/local/bin/penge-mail-expire 1680
UNIT
  cat >/etc/systemd/system/penge-mail-expire.service <<'UNIT'
[Unit]
Description=Delete mail queued 28 minutes or more

[Service]
Type=oneshot
ExecStart=/usr/local/bin/penge-mail-expire 1680
TimeoutStartSec=50s
UNIT
  cat >/etc/systemd/system/penge-mail-expire.timer <<'UNIT'
[Unit]
Description=Delete stale queued mail every minute

[Timer]
OnCalendar=minutely
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now opendkim postfix >/dev/null 2>&1
  systemctl restart opendkim
  systemctl restart postfix
  systemctl enable -q --now penge-mail-expire.timer
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

Then set the reverse DNS (PTR) of $IP to $MAILHOST in your provider's panel
(it may insist that $MAILHOST already points to $IP). Check everything with: bash check-mail-dns.sh $DOMAIN
NEXT
