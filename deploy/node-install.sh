#!/usr/bin/env bash
# Installs or updates Node.js to the newest release of one major line.
# Installed as /usr/local/bin/penge-node-install; provision.sh runs it, and
# penge-node-update.timer runs it weekly so security releases arrive.
#
#   penge-node-install [major]        (default 24)
#
# The release's SHASUMS256.txt must carry a valid signature from the Node.js
# release keys pinned in keys/nodejs-release-keys.kbx (from
# github.com/nodejs/release-keys, a different origin than the download).
set -euo pipefail

MAJOR=${1:-24}
KEYRING=${NODE_KEYRING:-/usr/local/share/penge/nodejs-release-keys.kbx}
[[ $MAJOR =~ ^[0-9]+$ ]] || { echo "major must be a number" >&2; exit 2; }

latest=$(curl -fsS https://nodejs.org/dist/index.json | grep -o "\"version\":\"v$MAJOR\.[0-9]*\.[0-9]*\"" | head -1 | cut -d'"' -f4)
[[ $latest =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not find the latest v$MAJOR release" >&2; exit 1; }
current=$(/usr/local/bin/node --version 2>/dev/null || true)
if [[ $current == "$latest" ]]; then
  echo "node $current is the latest v$MAJOR"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tarball="node-$latest-linux-x64.tar.xz"
for f in "$tarball" SHASUMS256.txt SHASUMS256.txt.sig; do
  curl -fsSLo "$tmp/$f" "https://nodejs.org/dist/$latest/$f"
done
gpgv --keyring "$KEYRING" "$tmp/SHASUMS256.txt.sig" "$tmp/SHASUMS256.txt" 2>/dev/null ||
  { echo "the signature on SHASUMS256.txt for $latest does not verify" >&2; exit 1; }
(cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -)

dest="/opt/node-$latest"
rm -rf "$dest.partial"
mkdir -p "$dest.partial"
tar -xJf "$tmp/$tarball" -C "$dest.partial" --strip-components=1
"$dest.partial/bin/node" --version >/dev/null
rm -rf "$dest"
mv "$dest.partial" "$dest"

# Earlier installs put Node straight into /opt/node; keep it as a versioned directory.
if [[ -d /opt/node && ! -L /opt/node ]]; then
  mv /opt/node "/opt/node-${current:-old}"
fi
# Switch atomically: at every moment /usr/local/bin/node points at a complete install.
ln -sfn "$dest" /opt/node.new
mv -T /opt/node.new /opt/node
ln -sfn /opt/node/bin/node /usr/local/bin/node
echo "node $latest installed (was ${current:-none})"

# Keep the running version and one before it.
find /opt -maxdepth 1 -name 'node-v*' -type d ! -name "node-$latest" ! -name "node-${current:-none}" -exec rm -rf {} +
if systemctl is-active --quiet penge-api.service; then
  systemctl restart penge-api.service
fi
