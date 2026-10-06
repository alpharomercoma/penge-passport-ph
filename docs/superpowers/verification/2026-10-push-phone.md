# Push notifications on the owner's phone (Task 18)

Date: 6 October 2026, branch `push-notifications`, the local stack (`scripts/local-stack.sh up`)
reached from the phone over `adb reverse` (wireless debugging), with the owner's yes for each step.
Steps 1 and 2 (the debug app's build, and the four checks `android/dev/build-dev.sh` makes on it:
notification permission, delegation, https launch, `localhost:8443`) passed and were committed in
`0884b37`; see `android/dev/README.md`.

**Phone:** the owner's Android phone, Chrome `154.0.8037.92` (as it reported itself), 1280×2772 at
density 520 (about 394 CSS pixels wide), in dark mode throughout (its own setting, left as it was).
Chrome's notification permission was allowed for this test at the owner's choice ("allow Chrome,
revoke after").

**How results were checked:** DevTools forwarded from the phone (`localabstract:chrome_devtools_remote`)
for reading the page; real taps (`adb shell input tap`, found with `uiautomator`) for the phone's own
prompts and the notification shade, because DevTools mouse input does not reach the page on Android.
Notifications are read from the service worker (`getNotifications()`) and from Android
(`dumpsys notification --noredact`, for which app posted them). Screenshots: `img/phone-*`, cropped
to leave out the owner's own notifications. Scripts: `harness/phone-tab.mjs`, `harness/phone-app.mjs`,
`harness/phone-pwa.mjs` (they read the phone's serial from `ADB_SERIAL`); results with run ids in
`results/phone-*.json`.

## The gate's stop condition was hit

The plan stops the gate if the debug app shows no Android permission prompt. It showed Chrome's site
prompt instead ("localhost:8443 wants to send notifications"), the app's own notification permission
stayed off (`POST_NOTIFICATIONS: granted=false` for `com.alphaexperiments.pengepassportph.dev`), and
the alert arrived as a Chrome notification (`pkg=com.android.chrome`), not as the app's. So Chrome did
not delegate notifications to the debug app. The likely reason: Chrome delegates only to an app whose
Digital Asset Links it has verified, and the debug app skips that check with a command-line flag
(`--disable-digital-asset-link-verification-for-url`) rather than passing it. This does not show how
the release app (1.1.0, verified by the live `assetlinks.json`) behaves.

**Outstanding before 1.1.0 goes to Play** (no task in the plan covers it yet; it needs push live in
owner mode on the site, and the release APK signed with the upload key, whose fingerprint the live
`assetlinks.json` already lists, installed on the owner's phone with the owner's yes):

- Turning the switch on shows Android's own prompt naming the app, not Chrome's site prompt.
- An alert is posted by the app's package (`dumpsys notification`), with the app's icon and name.
- Tapping it opens the app on the office, with the date and group.
- Denied in the prompt: the switch shows the Android settings hint. Allowed, then turned off in
  Android's settings for the app: the row says notifications are blocked.
- If Chrome still does not delegate to the verified app, 1.1.0 does not go to Play with notifications
  presented as the app's; that is the owner's decision then.

The owner chose to continue the run for information. Nothing went to the server or GitHub.

## Chrome tab (`phone-tab.mjs`)

| Check | Result | Screenshot |
| --- | --- | --- |
| Detected as a browser (`context: browser`) | pass | |
| The switch reads "Browser notifications" | pass | `phone-tab-sheet` |
| Chrome's site prompt, then Android's prompt for Chrome itself, allowed by real taps | pass | `phone-tab-prompt`, `phone-chrome-os-prompt` |
| Push on, email off | pass | `phone-tab-sheet` |
| The email says "Notifications: on, for the device and browser that asked (Chrome on Android, …)" | pass | |
| The confirmation page lists both channels before its button | pass | `phone-tab-confirm-preview` |
| Confirmed: "Notifications are on for this device."; one registered device | pass | `phone-tab-confirmed` |
| The row says "Notifications on this device: On" | pass | `phone-tab-row-on` |
| An alert arrives as a Chrome notification, "Dates open at Antipolo", through FCM | pass | `phone-tab-notification` |

The script stopped at its last screenshot (adb's output overflowed the default buffer); every check
had passed, and the screenshot was taken after the buffer was raised.

## The debug app (`phone-app.mjs`)

| Check | Result | Screenshot |
| --- | --- | --- |
| Opens with no address bar; `context: play` | pass | `phone-app-open` |
| The switch reads "Notifications on this device" | pass | `phone-app-sheet` |
| Android's own prompt naming "PassportPH dev" | **fail**: Chrome's site prompt asked instead (above) | |
| The email names "Chrome on Android" | pass | |
| Confirmed in the app; one registered device | pass | `phone-app-confirmed` |
| The row says On | pass | `phone-app-row-on` |
| An alert shows a notification | pass | |
| Posted as the app's notification | **fail**: posted by Chrome | `phone-app-notification` |
| Tapping it opens the app on Antipolo with the date and group (`?office=486&date=…&people=1`) | pass (the first tap hit the Chrome tab's card above it; retried on the right card) | `phone-app-tapped` |

Denied in the prompt, and revoked in Android's settings for the app, were not run: with no
delegation they would test Chrome's site settings, which the Mac runs already cover.

## Installed from Chrome (`phone-pwa.mjs`)

"Install" from Chrome's menu made a WebAPK (`org.chromium.webapk.…`) for `localhost:4173`.

| Check | Result | Screenshot |
| --- | --- | --- |
| Install offered and made | pass | `phone-pwa-install` |
| Opens on its own; `context: installed` | pass | `phone-pwa-open` |
| The switch reads "Notifications on this device" | pass | `phone-pwa-sheet` |
| The row says On, after confirming in the Chrome tab of the same site | **fail** (timed out waiting for On); it said "Notifications are not allowed on this device yet. Allow them in your browser or phone settings." The WebAPK has its own Android notification permission, off (`granted=false`), although Chrome's is on | `phone-pwa-error` |

The script stopped there, waiting for "On" (`results/phone-pwa.json` keeps its failure; the reason
is added by hand under `annotations`). The alert and the tap from the installed app were not reached: its permission was off, and the
owner then asked for the layout check below before anything more was recorded.

## Layout (the owner asked for this before the results were recorded)

`harness/audit.mjs` drives Mac Chrome emulating Android Chrome (and, for the sheet, iPhone Safari)
through 19 screens and states: home, Abroad, an office, by date; the sheet at its top, its switches,
push only, its end, sent, with notifications blocked, and in an iPhone tab; the row waiting, on and
blocked; the confirmation page before and after; privacy, delete data, and the unsubscribe page
opened without a link (its "incomplete link" screen only; its button and success screen were not
shown). Each at 320, 360,
375, 390, 412, 768 and 1280 pixels. The other row states (not allowed yet, off, needs setting up
again) were not shown in the audit; the phone's screenshots show "not allowed yet" at 394 pixels. It
flags a page that scrolls sideways, anything past the screen's edge, and text clipped by its box; it
first proves it catches a planted overflow and a clipped label. The run after the fixes finished all
19 states with no findings (`results/audit.json`); the runs before them also flagged nothing, by their
console output, which was not kept, but they did not really show the "by date" view (the tap on it
failed on a wide screen and was ignored; the audit now stops on any failed step). By eye, three things were wrong, now fixed:

- The sheet's sticky title left a 12-pixel gap below it with no background: scrolled text showed in
  it, sliced. The gap is now padding, with a divider.
- The row's links wrapped one by one ("Send a test" beside the text, "Turn off" below). They now sit
  together on their own line (test: "keeps the row's links together…").
- The sheet's height was 92% of `vh`, which on phones counts the screen as if the browser's bars were
  hidden; it is now 92% of `dvh` (with `vh` for older browsers). Checked in emulation only: the phone
  had locked itself before the sheet could be measured in its Chrome tab.

Fixed in `4c7389a` (the row's test went red, then green; the audit reran clean).

Left as they are: at 320 pixels the home heading takes three lines beside the alerts button, and an
office's "Email me when dates open here" takes two.

## Phone cleanup

Done over adb with the phone locked. Each line is the command's own answer, read at the time (the
output itself was not kept):

- Uninstalled the debug app (`com.alphaexperiments.pengepassportph.dev`) and the WebAPK installed
  from Chrome: both `Success`; `pm list packages` then lists neither.
- Removed `/data/local/tmp/chrome-command-line` (`ls` no longer lists it); chrome://flags "Enable
  command line on non-rooted devices" set to Default (`harness/flags.mjs off` read it back as
  `Default`).
- Revoked Chrome's notification permission, as the owner chose: `dumpsys package` then shows
  `POST_NOTIFICATIONS: granted=false`.
- Cleared every kind of site data for `http://localhost:4173` and `https://localhost:8443`
  (`Storage.clearDataForOrigin`; `Storage.getUsageAndQuota` then reports 0 bytes for each), reset
  site permissions (`Browser.resetPermissions`), closed the test pages.
- Removed the `adb reverse` ports 8443 and 4173 and the DevTools forward: `adb reverse --list` is then
  empty, and `adb forward --list` shows only a forward on 8080 that this test did not make (left
  alone).
- Dark mode left on, as it was (`cmd uimode night`: yes). Every phone screenshot above was taken in
  dark mode and reads clearly (checked by eye); light mode was checked on the Mac.

Still to do by the owner: restart Chrome on the phone once, so the running browser drops the
switches it read from the command-line file at its last start.

The local stack stays up for the remaining local check (the old service worker replaced by the new
one, across two builds served in turn) and is stopped with `scripts/local-stack.sh down` after it.
