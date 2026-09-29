#!/usr/bin/env bash
# Builds the Android app, a Trusted Web Activity that shows the website full
# screen, with Bubblewrap: a signed app bundle (.aab) to upload to Google Play
# and a signed APK to install for testing, both in android/out/. docs/android.md
# has the whole release.
#
#   android/build.sh
#
# Needs JDK 17 (Bubblewrap accepts no other), the Android SDK with build-tools
# 36.1.0, and the upload key: .secrets/android/upload.keystore, with its
# passwords in .secrets/android/keystore.env. Only twa-manifest.json is kept in
# git; the Android project is generated from it into android/project/ each time.
set -euo pipefail

BUBBLEWRAP=@bubblewrap/cli@1.25.0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
manifest="$here/twa-manifest.json"
project="$here/project"
out="$here/out"
key="$repo/.secrets/android/upload.keystore"
passwords="$repo/.secrets/android/keystore.env"

java_home="${JAVA_HOME_17:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
sdk="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

fail() { echo "android/build.sh: $*" >&2; exit 1; }
grep -qs 'JAVA_VERSION="17\.' "$java_home/release" || fail "no JDK 17 at $java_home (set JAVA_HOME_17)"
[[ -d "$sdk/build-tools/36.1.0" ]] || fail "no Android SDK with build-tools 36.1.0 at $sdk (set ANDROID_HOME)"
[[ -f "$key" && -f "$passwords" ]] || fail "no upload key in .secrets/android/ (docs/android.md, \"The upload key\")"
# Bubblewrap passes these paths to a shell unquoted.
[[ "$repo" != *[[:space:]]* ]] || fail "the repository path has a space in it: $repo"

mkdir -p "$project" "$out"
# Bubblewrap looks for the SDK's command-line tools in bin/ at its root, where
# its own download puts them; a standard SDK keeps them in cmdline-tools/latest/bin.
# It gets a view of the SDK made of links, with bin/ added.
view="$sdk"
if [[ ! -d "$sdk/bin" && ! -d "$sdk/tools" ]]; then
  [[ -d "$sdk/cmdline-tools/latest/bin" ]] || fail "no command-line tools in $sdk/cmdline-tools/latest"
  view="$project/sdk"
  rm -rf "$view"
  mkdir "$view"
  for entry in "$sdk"/*; do ln -s "$entry" "$view/"; done
  ln -s "$sdk/cmdline-tools/latest/bin" "$view/bin"
fi
# Bubblewrap's settings for this machine, kept out of ~/.bubblewrap. On macOS it
# adds Contents/Home to the JDK's path itself.
jdk="$java_home"
[[ "$(uname)" == Darwin ]] && jdk="${java_home%/Contents/Home}"
config="$project/bubblewrap-config.json"
printf '{"jdkPath":"%s","androidSdkPath":"%s"}\n' "$jdk" "$view" > "$config"

# The passwords reach Bubblewrap through the environment. It hands them on to
# apksigner and jarsigner as arguments, so while it signs they show in this
# machine's process list: build on a machine only you use.
set -a
# shellcheck source=/dev/null
. "$passwords"
set +a
[[ -n "${BUBBLEWRAP_KEYSTORE_PASSWORD:-}" && -n "${BUBBLEWRAP_KEY_PASSWORD:-}" ]] || fail "keystore.env sets no passwords"

cd "$project"
# The version comes from twa-manifest.json as it is: raise appVersionCode there for each upload.
npx --yes "$BUBBLEWRAP" update --skipVersionUpgrade --manifest="$manifest" --directory="$project" --config="$config"

# What Bubblewrap cannot express: from android/res/, a splash for dark mode as well (a
# night background, and an image with transparent corners that suits both; Bubblewrap's
# has the light background baked in) and the themed icon's layer; then android/patch.cjs.
cp -R "$here/res/." "$project/app/src/main/res/"
node "$here/patch.cjs" "$project" "$manifest"

npx --yes "$BUBBLEWRAP" build --manifest="$manifest" --directory="$project" --config="$config" --signingKeyPath="$key"

version="$(node -p "require('$manifest').appVersionCode")"
cp app-release-bundle.aab "$out/pengepassportph-$version.aab"
cp app-release-signed.apk "$out/pengepassportph-$version.apk"
echo
echo "Built version $version:"
ls -l "$out/pengepassportph-$version".*
