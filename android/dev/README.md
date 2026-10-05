# The debug Android app (the phone check for push)

A separate app, `com.alphaexperiments.pengepassportph.dev` ("PassportPH dev"), that opens the
local stack at `https://localhost:8443/pengepassportph/` instead of the website, so push can be
tried on a phone before anything changes on the server or on Google Play.

It never touches the real app: its own package, its own project (`android/project-dev/`), its own
output (`android/out-dev/`), and a throwaway debug key made on first use in `.local/android/`.
None of these are in git.

## Build

```sh
scripts/local-stack.sh up        # Bubblewrap fetches the icons from it
bash android/dev/build-dev.sh    # android/out-dev/pengepassportph-dev.apk
```

The script stops unless the built app asks for notification permission, delegates notifications
to the site, launches over https, and opens `localhost:8443`.

## On a phone (only with the owner's yes)

The phone reaches the Mac's local stack through `adb reverse`. Chrome on the phone must trust the
local certificate and skip the Digital Asset Links check for `localhost:8443`, which it does only
with a test command line and the chrome://flags switch "Enable command line on non-rooted
devices". The exact commands, and how to undo every one of them, are in Task 18 of
`docs/superpowers/plans/2026-10-05-push-notifications.md`; the results go in
`docs/superpowers/verification/2026-10-push-phone.md`.
