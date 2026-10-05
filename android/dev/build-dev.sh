#!/usr/bin/env bash
# Builds the debug Android app for the phone gate: package ...pengepassportph.dev,
# opening https://localhost:8443/pengepassportph/ (the local stack, through adb
# reverse), signed with a throwaway debug key. Output: android/out-dev/.
# Needs the local stack running (scripts/local-stack.sh up): Bubblewrap fetches the
# icons from it, trusting its certificate.
set -euo pipefail

BUBBLEWRAP=@bubblewrap/cli@1.25.0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
repo="$(dirname "$android")"
manifest="$here/twa-manifest.dev.json"
project="$android/project-dev"
out="$android/out-dev"
key="$repo/.local/android/debug.keystore"
cert="$repo/.local/tls/cert.pem"

java_home="${JAVA_HOME_17:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
sdk="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

fail() { echo "android/dev/build-dev.sh: $*" >&2; exit 1; }
grep -qs 'JAVA_VERSION="17\.' "$java_home/release" || fail "no JDK 17 at $java_home (set JAVA_HOME_17)"
[[ -d "$sdk/build-tools/36.1.0" ]] || fail "no Android SDK with build-tools 36.1.0 at $sdk (set ANDROID_HOME)"
[[ -f "$cert" ]] || fail "no local certificate: run scripts/local-stack.sh up first"
curl -sf --cacert "$cert" https://localhost:8443/pengepassportph/manifest.webmanifest >/dev/null || fail "the local stack is not answering on https://localhost:8443"

mkdir -p "$project" "$out" "$(dirname "$key")"
if [[ ! -f "$key" ]]; then
  "$java_home/bin/keytool" -genkeypair -keystore "$key" -alias debug -keyalg RSA -keysize 2048 -validity 30 \
    -dname CN=debug -storepass android -keypass android >/dev/null
fi

# The same SDK view and Bubblewrap settings as android/build.sh.
view="$sdk"
if [[ ! -d "$sdk/bin" && ! -d "$sdk/tools" ]]; then
  view="$project/sdk"
  rm -rf "$view"
  mkdir "$view"
  for entry in "$sdk"/*; do ln -s "$entry" "$view/"; done
  ln -s "$sdk/cmdline-tools/latest/bin" "$view/bin"
fi
jdk="$java_home"
[[ "$(uname)" == Darwin ]] && jdk="${java_home%/Contents/Home}"
config="$project/bubblewrap-config.json"
printf '{"jdkPath":"%s","androidSdkPath":"%s"}\n' "$jdk" "$view" > "$config"

export BUBBLEWRAP_KEYSTORE_PASSWORD=android BUBBLEWRAP_KEY_PASSWORD=android
# Bubblewrap downloads the icons from the local stack: trust its certificate for that.
export NODE_EXTRA_CA_CERTS="$cert"

cd "$project"
npx --yes "$BUBBLEWRAP" update --skipVersionUpgrade --manifest="$manifest" --directory="$project" --config="$config"
# As android/build.sh: android/res/ first (the patch refers to @drawable/ic_launcher_monochrome), then the patch.
cp -R "$android/res/." "$project/app/src/main/res/"
node "$android/patch.cjs" "$project" "$manifest"
npx --yes "$BUBBLEWRAP" build --manifest="$manifest" --directory="$project" --config="$config" --signingKeyPath="$key"

grep -q 'android.permission.POST_NOTIFICATIONS' "$project/app/src/main/AndroidManifest.xml" || fail "no notification permission"
grep -q 'DelegationService' "$project/app/src/main/AndroidManifest.xml" || fail "no notification delegation"
grep -q '"https://" + twaManifest.hostName' "$project/app/build.gradle" || fail "the launch URL is not https"
grep -q "hostName: 'localhost:8443'" "$project/app/build.gradle" || fail "the debug app does not open localhost:8443"

cp app-release-signed.apk "$out/pengepassportph-dev.apk"
echo
ls -l "$out/pengepassportph-dev.apk"
