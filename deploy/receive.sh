#!/usr/bin/env bash
# Installed as /usr/local/bin/penge-receive; reached only through
# penge-deploy-gate. Reads one release, a gzipped tar on stdin, into
# /opt/penge/releases/<id>.partial for penge-activate to publish.
set -euo pipefail

id=${1:?usage: penge-receive <release-id>}
[[ $id =~ ^[A-Za-z0-9._-]+$ && $id != *.partial ]] || { echo "bad release id" >&2; exit 2; }
releases=/opt/penge/releases
dest=$releases/$id.partial
[[ ! -e $dest && ! -e $releases/$id ]] || { echo "release $id already exists" >&2; exit 2; }
mkdir -m 0755 "$dest"
trap 'rm -rf "$dest"' ERR

# At most 100 MB. Owners and modes in the archive are ignored; GNU tar refuses
# absolute paths and "..", and anything but plain files and folders is refused below.
head -c 100000000 | tar -xz --no-same-owner --no-same-permissions -C "$dest"
if [[ -n $(find "$dest" \( -type l -o \( ! -type f ! -type d \) \) -print -quit) ]]; then
  rm -rf "$dest"
  echo "links and special files are not allowed in a release" >&2
  exit 2
fi
chmod -R u=rwX,go=rX "$dest"
echo "received $id"
