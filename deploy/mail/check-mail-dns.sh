#!/usr/bin/env bash
# Checks the DNS records that decide whether mail from this server reaches
# inboxes: forward and reverse DNS, SPF, DKIM (against the key on this
# server) and DMARC. Exit 0 only if every check passes.
#
#   bash check-mail-dns.sh [domain]     (defaults to the one setup-mail.sh configured)
set -uo pipefail

# Defaults come from what setup-mail.sh recorded.
if [[ -r /etc/penge/mail.conf ]]; then
  # shellcheck source=/dev/null
  . /etc/penge/mail.conf
fi
DOMAIN=${1:-${MAIL_DOMAIN:?usage: check-mail-dns.sh <domain>}}
MAILHOST=${MAILHOST:-mail.$DOMAIN}
SELECTOR=${SELECTOR:-penge}
IP=${PUBLIC_IP:-$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')}
# Behind 1:1 NAT (Huawei, AWS, Google…) the interface holds a private address,
# not the one the world sees: then PUBLIC_IP must say which that is.
if [[ $IP =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; then
  echo "!! $IP is a private address: run again with PUBLIC_IP=<this server's public IPv4>" >&2
  exit 2
fi
KEYFILE=/etc/opendkim/keys/$DOMAIN/$SELECTOR.txt
command -v dig >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bind9-dnsutils >/dev/null 2>&1
# One line per record; a record split into several strings is joined back.
q() { dig +short "$@" @1.1.1.1 | sed 's/" "//g; s/"//g'; }
failed=0
pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1"; failed=1; }

# Any of its addresses will do: while moving servers, the name points at both.
a=$(q A "$MAILHOST" | sort | paste -sd ' ' -)
if [[ " $a " == *" $IP "* ]]; then pass "A $MAILHOST → $IP"; else fail "A $MAILHOST: got '${a:-nothing}', want $IP"; fi

ptr=$(q -x "$IP" | head -1)
if [[ $ptr == "$MAILHOST." ]]; then pass "PTR $IP → $MAILHOST"; else fail "PTR $IP: got '${ptr:-nothing}', want $MAILHOST (set it in your provider's panel)"; fi

spf=$(q TXT "$DOMAIN" | grep '^v=spf1' | head -1 || true)
if [[ $spf == *"ip4:$IP"* && $spf == *"-all"* ]]; then pass "SPF allows $IP"; else fail "SPF: got '${spf:-nothing}'"; fi

want=$(tr -d '\n\t "()' <"$KEYFILE" 2>/dev/null | sed -n 's/.*p=\([A-Za-z0-9+/=]*\).*/\1/p')
got=$(q TXT "$SELECTOR._domainkey.$DOMAIN" | tr -d ' ' | sed -n 's/.*p=\([A-Za-z0-9+/=]*\).*/\1/p' | head -1)
if [[ -n $want && $got == "$want" ]]; then
  pass "DKIM $SELECTOR._domainkey matches this server's key"
else
  fail "DKIM: the published key does not match $KEYFILE"
fi

dmarc=$(q TXT "_dmarc.$DOMAIN" | grep '^v=DMARC1' | head -1)
if [[ -n $dmarc ]]; then pass "DMARC published: $dmarc"; else fail "DMARC: nothing at _dmarc.$DOMAIN"; fi

# DMARC alignment: the app's From address must be on the domain OpenDKIM signs for.
# (Read without sourcing: server.env is systemd syntax, not shell.)
from=$(sed -n 's/^MAIL_FROM=//p' /etc/penge/server.env 2>/dev/null | tail -1)
if [[ $from == *"@$DOMAIN" ]]; then
  pass "MAIL_FROM $from is aligned with $DOMAIN"
else
  fail "MAIL_FROM is '${from:-unset}' in /etc/penge/server.env; it must end in @$DOMAIN"
fi

exit $failed
