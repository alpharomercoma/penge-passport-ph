# The Android app

The Google Play app is the website itself, shown full screen by the phone's browser. It is a
[Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity), built with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap). The app is a thin launcher, so a change to
the website reaches the app when the site deploys. A change to the Android side needs a rebuild and a new
upload: `android/twa-manifest.json` (name, start page, scope, colours, icons, target), `android/res/`,
`android/patch.cjs` or the pinned Bubblewrap version.

| What | Where |
| --- | --- |
| The app's settings: package name, name, colours, icons, start page, version | [`android/twa-manifest.json`](../android/twa-manifest.json) |
| The build | [`android/build.sh`](../android/build.sh), which generates the Android project into `android/project/` (not in git) and writes to `android/out/` (not in git) |
| What Bubblewrap cannot express: the dark-mode splash, the themed icon, the splash's scaling | [`android/res/`](../android/res) and [`android/patch.cjs`](../android/patch.cjs), applied to the generated project on every build |
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

## What it shows at launch

Recorded on an Android 16 emulator (the `ow-test` AVD, read-only, Chrome 133), launching from the home
screen. On a cold start:
1. the splash shows for about a second;
2. then the site appears full screen, with no address bar (Digital Asset Links verified);
3. Chrome shows a one-line "Running in Chrome" notice, which a Trusted Web Activity cannot turn off.
Android's own splash does not appear before ours.

- **The splash** is the app's icon on the site's background: white in light mode, `#101412` in dark
  mode.
  - Bubblewrap takes one background colour, so the dark one is a night resource
    (`android/res/values-night/colors.xml`). Without it, a phone in dark mode flashed a white screen
    before the dark page.
  - The image is the same in both modes. The helper library that shows the splash saves the image the
    first time the app opens and reuses it until the app is updated (`twa_splash/splash_image.png` in
    androidbrowserhelper 2.6.2), whatever the mode. A separate dark image showed on white after
    switching modes; the colour, read on every launch, did follow.
  - So the image is the icon with transparent corners (`android/res/drawable-*/splash.png`, from
    `apps/web/scripts/icons.mjs`). On white the tile disappears and only the mark shows; on the dark
    background it is the app's icon. Checked in both modes and in both orders.
  - The image is 300dp. The helper centres it at that size by default, which crops it in a window
    shorter than that (split screen, a small free-form window). `android/patch.cjs` makes it shrink to
    fit instead (`CENTER_INSIDE`); checked in a 200dp-tall free-form window on a tablet.
- **The navigation bar's divider** matches the bar: white in light mode, `#101412` in dark mode.
  Bubblewrap drops the alpha from colours, so a transparent divider (`#00000000`) came out as a black
  line above the navigation bar.
- **The launcher icon** is Bubblewrap's adaptive icon from `maskable-512.png`, with a monochrome layer
  added for Android 13+ themed icons (`android/res/drawable/ic_launcher_monochrome.xml`).
  - The monochrome layer is the mark in one colour, with the full days faint and the one open day
    solid, as in the favicon.
  - It is 50×51dp in the 108dp layer, inside the 66dp safe zone: Android asks for a logo of at least
    48×48dp.
  - Bubblewrap uses a monochrome icon only for notifications, so `android/patch.cjs` adds the layer to
    its `ic_launcher.xml`.
  - It is compiled into the APK, but hasn't yet been seen in a launcher with themed icons turned on.
- **The name under the icon** is "PassportPH" (`launcherName`): Bubblewrap allows 12 characters, and
  launchers cut longer names short.

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

With USB debugging on, `adb install android/out/pengepassportph-1.apk`. An emulator works as well: start
it with `-read-only` and nothing it installs is kept. The first launch on a device where Chrome was never
opened shows Chrome's own welcome screen before the app; that is Chrome's, and happens once.

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

**The developer account and what it makes public**
([Google](https://support.google.com/googleplay/android-developer/answer/13628312)). A personal account
has two email addresses:
- **Contact email:** private; Google uses it to reach you.
- **Developer email:** public, shown on your developer profile on Google Play.

Your **legal name and country** are also shown publicly on a personal account's profile. Each app's
listing also needs a **support email**, which is public too. Use addresses made for this app for both
public ones, never a personal one.

**Testing first, for new personal accounts.** A personal Play Console account created after 13 November
2023 must run a closed test first. At least 12 testers have to stay opted in for 14 days in a row. Only
then can you apply for production access from the Dashboard, and that review "typically takes seven days
or less"
([Google](https://support.google.com/googleplay/android-developer/answer/14151465)).

**Device verification, for new personal accounts.** A new personal account must also show it has a real
Android phone, through the Play Console mobile app, before an app can go live on Google Play: any
non-rooted physical phone running Android 10 or later
([Google](https://support.google.com/googleplay/android-developer/answer/14316361)).

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

## Verify production inputs

Before submitting production, run:

```sh
node android/check-play-release.mjs --play-sha256 '<Play app signing certificate SHA-256>' --support-email '<monitored public support address>'
```

Use the **App signing key certificate**, not the upload certificate. The check only reads the live site and local settings. Missing inputs or a certificate absent from the live asset links fail it. Verify the actual Play-installed app and pre-launch report afterward: a successful sideload does not prove Play signing or physical-device behaviour. For the optional account/data deletion URL in Console, use `https://alphaexperiments.com/pengepassportph/delete-data`; it works without a previous alert.
