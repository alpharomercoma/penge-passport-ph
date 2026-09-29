# When alerts go out, and how time is measured

This records how the checker decides when to email someone, why it works that way, and what two
adversarial reviews found on the way there (29 September 2026). The rules themselves are also in the
[runbook](../deploy/README.md#what-the-checker-does-and-when-it-refuses-to-email); the code is
`deliver()`, `consider()` and `splitByOpen()` in `apps/server/src/checker.ts`, and `apps/server/src/clock.ts`.

## Why the daily cap went

Until 29 September each subscriber got at most 3 alerts a Manila day, and everything past that was dropped
for good. On 28 September the only subscriber at the time used their 3 by 02:04 Manila (17:04, 17:19 and
18:04 UTC on the 27th). The 8 checks after that which found new dates for their offices, between 03:06 and
10:04 Manila, sent nothing; nor would the 12 noon and 9 PM releases have. A count that runs out early drops
exactly the news people signed up for.

## How it works now

**A pace, not a count.** Each subscriber chooses one (`PACES` in `packages/contracts`):

| Pace | Gap between emails | At most |
| --- | --- | --- |
| `hourly` (the default, and every subscription from before paces existed) | 60 minutes, strictly | 24 a day |
| `asap`, "As soon as a check finds dates" | One per check (checks start every 15 minutes; the Philippines and the posts abroad in one check count as one), and never within 5 minutes | 96 a day |

`ALERTS_PER_SUBSCRIBER_PER_DAY` (96) is only a safety net above both; `MAIL_DAILY_LIMIT` (300 emails a day
for the whole site) still protects the domain's reputation and will need raising as subscribers grow.

**Nothing is dropped for coming too soon.** What a check finds before a person's next email is due waits in a
signed record (`pp:held:<id>`, listed in `pp:held-subs`) and goes out with that email. Before sending:

- only dates open at the latest good look go out; a group (2 to 5 people) also needs the date open for one;
- a date that closed while it waited keeps waiting, in case it opens again (the 3-hour announcement window
  would stop it being queued a second time, and this person was never told);
- each date expires on its own, 3 hours after it was first queued, and counts its own refused sends (3 at
  most);
- the email is marked sent before it goes out, as an outbox entry is popped first: a crash can lose one
  alert but never send it twice. A refusal from the mail server undoes that in one write and tries again.

## How time is measured

The gap between emails, the 3-hour life of a waiting date and the 3-hour announcement window are timed with
stamps (`clock.ts`): the wall clock, the kernel's uptime (`/proc/uptime`, which no clock setting moves) and the
boot id (`/proc/sys/kernel/random/boot_id`). Within a boot, time is the difference in uptime, so an NTP step,
a VM restored from a snapshot or a date set by hand can neither shorten nor stretch any of them.

Across a reboot, or a move of the data to another machine and back, nothing can tell how long it has been:
the wall clock may come back ahead or behind, and boots on two machines cannot be put in order. A moment from
another boot therefore counts as unknown, and what it was timing starts again. The first run of each boot
(under the checker lock) restarts every person's gap at once and then marks the boot seen
(`pp:boot-seen:<boot>`), so after a reboot the hour counts from the reboot. A reboot or a move can delay
someone's next email by one pace at most, and never brings it forward.

Also unknown, and restarted: a stamp written before boots were recorded, one later than now in the same boot
(data restored from elsewhere), and one with uptime read at a moment the uptime could not be read. Only a
system with no uptime at all (a laptop, the tests) falls back to the wall clock.

Last-alert times (`pp:last-alert:<id>`) have no Redis expiry: Redis expires keys by the wall clock, and a
clock jump that erased one would let an email go early. They go when the person unsubscribes. Held alerts
and announcement marks keep 7-day expiries, only for tidying up.

## What the server's clock was doing

The server had no working time source. Huawei's Debian image sets chrony to `ntp.myhuaweicloud.com` alone,
which does not resolve from the server (like Huawei's internal DNS server, 100.125.1.250), and its
`chrony.conf` never reads `/etc/chrony/sources.d`. After about 43 hours of uptime the clock was 2.4 s slow,
by chrony's own reading against Cloudflare and `asia.pool.ntp.org`. `provision.sh` now adds those two as
sources and the `sourcedir` line; on 29 September the clock was brought within a millisecond of NTP time.
Check it with `timedatectl show -p NTPSynchronized` (should say `yes`) and `chronyc tracking`.

## What the reviews found

Both changes were reviewed by codex (`gpt-6-luna`, `model_reasoning_effort="xhigh"`, read-only) before they
were committed, pass after pass until nothing it raised was left unanswered. Every finding accepted was first
reproduced by a test that failed, then fixed, then the fix was broken on purpose to show the test catches it.

### Pacing (commit bcdc54f): 3 passes, 14 findings

| Pass | Finding | Outcome |
| --- | --- | --- |
| 1 | A held alert could be sent twice after a crash between the send and the write that clears it | Fixed: the send is claimed first |
| 1 | Hitting `MAIL_DAILY_LIMIT` held only the open dates and lost closed ones that were waiting | Fixed: all of them wait |
| 1 | A group could be emailed a date with no room even for one person (the group baseline is deleted when an office has no dates, and missing read as "unknown") | Fixed: a group date must be open for one too |
| 1 | A new date merged into an old held record expired with it | Fixed: ages per date |
| 1 | An unsubscribe racing a delivery could still get the email | Narrowed: the subscriber is checked again right before the claim |
| 1 | A forward clock step could let the next email go early | Accepted then; fixed by the clock change below |
| 1 | A backup with a non-text pace was accepted as if it had none | Fixed: checked before the field filter |
| 1 | (Found alongside: a held record signed for someone else could be merged into another person's email) | Fixed: it is ignored |
| 2 | The unsubscribe re-check and the claim are not one atomic step | Accepted: the window is a few milliseconds, narrower than before paces existed; closing it needs a conditional write the key-value layer does not have |
| 2 | A new date inherited an old alert's used-up retry count and was lost with it | Fixed: tries per date |
| 2 | "Hourly" allowed two emails 55 minutes apart | Fixed: a strict 60 minutes |
| 2 | "asap" could send twice in one check (the Philippines, then the posts abroad) | Fixed: one email per person per check |
| 2 | A 48-a-day cap was below the 96 checks an "asap" subscriber could get | Fixed: 96 |
| 2 | The rollback after a refusal was several writes: a crash in between could lose the alert | Fixed: one write, with a new `decr` batch operation |
| 3 | The runbook's mail-pause note still said alerts over an hour old are dropped | Fixed |

### Clock steps (commits c5f0a32, 624bd02): 6 passes, 19 findings

| Pass | Finding | Outcome |
| --- | --- | --- |
| 1 | After a reboot with the clock set back, an unknown gap counted as "long ago" and let an email out early | Fixed: unknown restarts the gap |
| 1 | The same rule could drop a waiting date | Fixed: its 3 hours restart |
| 1 | Records written before stamps existed were still wall-clock only | Fixed (later replaced by "unknown") |
| 1 | `provision.sh` would abort where chrony is installed but stopped | Fixed: decided by the package, then enabled and restarted |
| 2 | The 3-hour announcement window still ran on Redis's wall-clock expiry | Fixed: marks carry stamps |
| 2 | Stamps from a previous boot kept being measured by the wall clock | Fixed (later replaced by "unknown") |
| 2 | A server rebooting again and again within the hour keeps restarting gaps | Accepted |
| 3 | A clock that comes back ahead after a reboot made the last email look hours old | Fixed: no wall clock is trusted across a reboot |
| 4 | Counting another boot's stamp as "at least this boot's uptime" breaks when the data moves to a machine that has been up for hours | Fixed (see below) |
| 4 | A same-boot stamp later than now (restored data) held an alert too long | Fixed: unknown |
| 4 | Redis's wall-clock expiry could erase the last-alert time after a jump of days | Fixed: no expiry |
| 4 | A failed uptime read fell back to comparing wall clocks | Fixed: unknown |
| 5 | A "first seen" record for the current boot can come back stale with the data after a move and a rollback | Fixed: dropped; other boots are unknown |
| 5 | A missing "first seen" record read as uptime 0 | Moot after the above |
| 5 | A held alert whose index entry was lost would stay forever without an expiry | Fixed: a 7-day tidy-up expiry |
| 6 | The first-run restart ran before the checker lock, and marked the boot seen before finishing | Fixed: under the lock, marked after |
| 6 | Last-alert records from the previous release kept a 2-hour expiry until the first run after the upgrade | Accepted: that run rewrites them, within 15 minutes of the deploy |
| 6 | Announcement marks from the previous release kept their 3-hour expiry | Accepted: they ran out on their own within 3 hours |
| 6 | Held records from the previous release kept a 4-hour expiry | Accepted: the first run after the upgrade holds them again with 7 days |

Three designs for the reboot case were tried and dropped, each on a concrete scenario:

1. **Credit the wall clock's age across a reboot.** A clock that comes back ahead makes the last email look
   old: an early email.
2. **Count another boot's moment as at least this boot's uptime.** True for a reboot, false when the data
   moves to a machine that was already up for hours: an early email.
3. **Count from when the checker first saw this boot.** Survives a move, not a move and a rollback: the old
   machine's record comes back with the data and is hours stale.

What remains is the only rule that needs no ordering of boots: another boot's time is unknown.

## Limits that remain

- A server that keeps rebooting within the hour keeps restarting hourly gaps.
- A clock jump of more than a week can let Redis drop a held alert or an announcement mark early. It cannot
  send an email early.
- Someone who unsubscribes in the few milliseconds between the last check and the claim can still get that
  one email.

## Lessons

- **Code that reads the machine must not be read by tests.** The checker reads `/proc/uptime` by default.
  macOS has no `/proc`, so the tests silently used the fake clock and passed; on Linux they read the real
  uptime, which barely moves while the fake clock jumps hours, and 11 failed on CI (commit c5f0a32, fixed in
  624bd02; CI blocked the deploy). Every test world now says where its time comes from, and a change like
  this is checked in a Linux container (`docker run node:24-bookworm-slim`) before it is pushed.
- **Reproduce first, against the old code.** Several times the new test itself was wrong: a helper that
  moved the fake clock 2 minutes on every call, an off-by-one at the 3-hour boundary, a test that passed
  without ever reaching the case. Requiring each test to fail before its fix, and pass after, is what
  showed it.
- **An equivalent "surviving" break is not a gap.** One deliberate break went uncaught because it could
  not change the outcome; the code was simplified instead of adding a test for it.
