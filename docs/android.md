# The Android app

The Google Play app is the website itself, shown full screen by the phone's browser. It is a
[Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity), built with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap). The app is a thin launcher, so a change to
the website reaches the app when the site deploys. Only a new name, icon, colour or Android target needs
a new upload.

| What | Where |
| --- | --- |
| The app's settings: package name, name, colours, icons, start page, version | [`android/twa-manifest.json`](../android/twa-manifest.json) |
| The build | [`android/build.sh`](../android/build.sh), which generates the Android project into `android/project/` (not in git) and writes to `android/out/` (not in git) |
| The website as an app: manifest, icons, service worker | `apps/web/public/manifest.webmanifest`, `apps/web/public/icons/`, `apps/web/src/sw.js` (built by `apps/web/sw-plugin.ts`) |
| The proof the app and the site belong together | [`apps/web/public/.well-known/assetlinks.json`](../apps/web/public/.well-known/assetlinks.json), served at `https://alphaexperiments.com/.well-known/assetlinks.json` |
| The upload key | `.secrets/android/` (not in git) |
| The store listing, graphics and Play Console answers | [`marketing/play-store/`](../marketing/play-store/README.md) |
| The privacy policy Play requires | https://alphaexperiments.com/pengepassportph/privacy (`apps/web/src/pages/Privacy.tsx`) |

The package name is **`com.alphaexperiments.pengepassportph`**. Once an app is uploaded under it, it can
never change: a different name is a different app, with no installs or reviews.

## How the pieces fit

- **Full screen needs proof.** Chrome shows the site without its address bar only when the site lists the
  app's signing certificate in `/.well-known/assetlinks.json` at the root of the domain. Without that, the
  app still works, but with an address bar, like a custom tab.
  - The file must list every certificate that signs an installed copy: the upload key for APKs built
    here, and Google Play's app signing key for copies installed from Play.
- **Only the site's path opens in the app.** Android verifies the whole host, but the app's link filter
  claims `/pengepassportph/` only (`fullScopeUrl`). Links to other paths on alphaexperiments.com, such as
  another project's, still open in the browser.
- **Offline.** The service worker keeps the page, its code and icons on the phone, so the app opens with
  no connection and says it cannot reach the server. Appointment dates are never stored: `/api/` always
  goes to the network. `apps/web/test/pwa.test.ts` runs the worker's rules against a fake cache.
- **Nothing extra is collected.** The app has no permissions of its own and no SDKs; notifications are
  off (`enableNotifications: false`). Its data is the website's, as the privacy page says.

## Tools

- **Node.js**, as for the rest of the repository. Bubblewrap is fetched by `npx` at the version pinned in
  `build.sh` (1.25.0).
- **JDK 17** exactly: Bubblewrap checks the version and accepts no other.
  - macOS: `brew install openjdk@17`. `build.sh` looks in Homebrew's place, or set `JAVA_HOME_17`.
- **The Android SDK**, with `platforms;android-36` and `build-tools;36.1.0`. Bubblewrap 1.25.0 targets
  API 36 and signs with build-tools 36.1.0.
  - macOS: `brew install --cask android-commandlinetools`, then:

    ```sh
    export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
    sdkmanager "platforms;android-36" "build-tools;36.1.0" "platform-tools"
    sdkmanager --licenses
    ```

  - `build.sh` looks in `/opt/homebrew/share/android-commandlinetools`, or set `ANDROID_HOME`.

## The upload key

Google Play signs the copies it delivers with its own key (Play App Signing). You sign each upload with
the **upload key**, which proves the upload is yours.

- It lives in `.secrets/android/upload.keystore` (alias `upload`, RSA 4096, valid until 2056).
- Its password is in `.secrets/android/keystore.env`, as `BUBBLEWRAP_KEYSTORE_PASSWORD` and
  `BUBBLEWRAP_KEY_PASSWORD` (the same value: a PKCS12 keystore has one password).
- Both files are mode 0600, and `.secrets/` is in `.gitignore`.
- The SHA-256 of its certificate is `C1:60:19:C4:8C:EE:B7:C9:F1:50:AA:2D:B3:D1:0B:63:2D:C5:58:A4:E9:76:87:EC:5C:5F:70:C3:A0:0D:53:FE`.
  It is public: it is in `assetlinks.json`.

**Back both files up somewhere other than this computer**, such as a password manager. If the key is
lost, Play can register a new upload key after you ask its support, but uploads stop until they do.

It was made with:

```sh
keytool -genkeypair -keystore .secrets/android/upload.keystore -storetype PKCS12 -alias upload \
  -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=PengePassportPH"
```

## Build

```sh
android/build.sh
```

This writes `android/out/pengepassportph-<version>.aab`, the bundle to upload to Play, and a `.apk` of
the same version to install on a phone for testing, both signed with the upload key.

- It reads the icons and the web manifest from the live site, so a change to them must be deployed
  first.
- While it signs, Bubblewrap passes the key's password to `apksigner` and `jarsigner` as arguments,
  which other users of the machine can see in the process list. Build on a machine only you use.

**A new version.** Raise `appVersionCode` by one in `android/twa-manifest.json` (Play refuses a code it
has seen before), and set `appVersion` to the version name users see. Commit that change and build.

To check an APK before uploading it:

```sh
sdk=/opt/homebrew/share/android-commandlinetools/build-tools/36.1.0
$sdk/apksigner verify --print-certs android/out/pengepassportph-1.apk   # the upload key's SHA-256
$sdk/aapt2 dump badging android/out/pengepassportph-1.apk | grep -E "^package|targetSdk|label"
```

## Try it on a phone

With USB debugging on, `adb install android/out/pengepassportph-1.apk`.

- **The app opens with no address bar:** Digital Asset Links verified.
- **There is an address bar at the top:** Chrome could not verify the app. Check the file with Google's
  checker:
  <https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://alphaexperiments.com&relation=delegate_permission/common.handle_all_urls>.

## Digital Asset Links

`apps/web/public/.well-known/assetlinks.json` ships with the website. Caddy serves it at the domain's
root (`handle /.well-known/assetlinks.json` in `deploy/caddy/Caddyfile.template`), as Android requires:

- over HTTPS;
- with no redirect;
- as `application/json`, which Caddy gives any `.json` file.

After the app is created in Play Console, add **Play's app signing key** to the file. Without it, copies
installed from Play show the address bar.

1. Find the key's SHA-256 in Play Console: your app, **App integrity**, the **App signing** tab, under
   "App signing key certificate".
2. Add it to `sha256_cert_fingerprints` next to the upload key's; keep both.
3. Commit, push, let the deploy finish, and check it with the link above.

The file covers the whole domain. If another app ever needs Digital Asset Links on alphaexperiments.com,
add its entry to this same file.

## Google Play

**The developer account.** Its contact email is shown to the public on the listing, so use an address
made for this app, not a personal one.

**Testing first, for new personal accounts.** A personal Play Console account created after 13 November
2023 must run a closed test first. At least 12 testers have to stay opted in for 14 days in a row. Only
then can you apply for production access from the Dashboard, and that review "typically takes seven days
or less"
([Google](https://support.google.com/googleplay/android-developer/answer/14151465)).

**Target API.** From 31 August 2026, new apps and updates must target Android 16, API level 36
([Google](https://support.google.com/googleplay/android-developer/answer/11926878)). The build does.
Google has raised it every year: when it does, update Bubblewrap's pinned version in `build.sh`,
build, and upload.

The first release, in order:

1. **Create the app.** Name PengePassportPH, default language English, App, Free.
2. **App content.** Fill in every declaration with the answers in
   [`marketing/play-store/README.md`](../marketing/play-store/README.md#app-content):
   - the privacy policy;
   - ads;
   - app access;
   - content rating;
   - target audience;
   - data safety;
   - **the Government apps declaration**, which Play requires of any app that shows government
     information.
3. **Store listing.** The text and graphics from the same file.
4. **Upload.** Upload `pengepassportph-1.aab` to a closed testing track, and accept Play App Signing
   when asked. Then add Play's app signing key to `assetlinks.json` and deploy (see above).
5. **Test.** Invite at least 12 testers by email list or Google Group. Keep them opted in for 14 days,
   then apply for production access. Each tester installs through the opt-in link Play gives.
6. **Production.** Once access is granted, promote the release to production.

**Later updates.** Most changes need no update: they are website changes, and they deploy as usual. For
the app itself, raise `appVersionCode`, build, and upload the new `.aab` to the same track.
