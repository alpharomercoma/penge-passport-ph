import { useEffect } from 'react';
import { BASE, REPO_URL } from '../links.ts';

/** What the site and the Android app keep, as the runbook's inventory records it (deploy/README.md). */
export const PRIVACY_UPDATED = '6 October 2026';

export function Privacy() {
  useEffect(() => {
    document.title = 'Privacy | PengePassportPH';
  }, []);

  return (
    <article className="prose">
      <h1>Privacy</h1>
      <p className="hint">Updated {PRIVACY_UPDATED}</p>
      <p>
        PengePassportPH is a free, open-source project, not run by or affiliated with the Department of Foreign Affairs.
        This page covers the website and the Android app, which shows the same website in your phone's browser and
        collects nothing more. It says what we keep about you, where, and for how long.
      </p>

      <h2>If you only look at dates</h2>
      <ul>
        <li>
          No account, no cookies, no ads, and no analytics or tracking scripts: the page loads nothing from other sites.
          The only counting is done on our server, as described below.
        </li>
        <li>
          The offices you choose for alerts are remembered in your browser, on your device, and reach us only when you
          sign up.
        </li>
        <li>
          To open without a connection, the site keeps a copy of its own pages and code on your device. Appointment
          dates are never stored there: they always come fresh from our server.
        </li>
        <li>
          When you open an office or tap a day, the page asks our server for its dates or hours, and our server asks
          passport.gov.ph when it needs to. Your network address and browser details are not passed on.
        </li>
        <li>
          We keep no log of visits. To stop abuse, the server counts requests per network address under a keyed hash of
          the address, never the address itself, and those counts expire after about two hours. When a request fails,
          the web server's error log may record the address; that log is kept for 14 days. When passport.gov.ph fails
          to answer, our log notes which office, day and group size were asked about, never who asked.
        </li>
        <li>
          To know how many people visit each day, the server hashes your network address and your browser's user agent
          (its name, version and system) with a random value that changes every day, and adds the hash to a counter
          that keeps an estimate of how many different hashes it saw, not the hashes. The daily value is deleted within
          25 hours; after that nobody, us included, can link your address to that day's count. We also count, never by
          whom, how often each office's dates are opened for one person, how often group dates are checked, and how
          often a day's hours are looked up.
        </li>
        <li>
          Each day's totals hold no one's details: how many people visited, how often offices were opened, how many
          signed up, unsubscribed or were sent alerts, and how the checks went. They stay on our server for 40 days, and
          each day's totals are also kept in our storage and emailed to us.
        </li>
      </ul>

      <h2>If you sign up for email alerts</h2>
      <p>
        We keep your email address, the offices you chose, how many people are booking, and how often you want to be
        emailed. We use them only to send the alerts you asked for and the email that confirms your sign-up, and to
        stop the sign-up form being used to flood someone's inbox. We never sell or share them, or use them for
        anything else.
      </p>
      <ul>
        <li>
          Your address is encrypted (AES-256-GCM) in our database and in its daily backups. We find your record by a keyed
          hash, not by the address. Your address is never written to the site's or the checker's logs.
        </li>
        <li>A sign-up that is never confirmed is deleted after 48 hours.</li>
        <li>Deletion links also expire after 48 hours. They store only a keyed address hash and a hash of the random link token. Deleting your data cancels all unused sign-up and deletion links.</li>
        <li>
          To stop the forms flooding an inbox, we count confirmation and deletion-link emails sent to each address, under a keyed hash
          of the address, and forget the count after about two days.
        </li>
        <li>
          To survive a restart, the database also writes every change to a log on its disk. The log is rewritten every
          hour, which drops anything deleted or expired, so a deleted address leaves it within the hour.
        </li>
        <li>
          Backups are kept for 14 days: every day the older ones are deleted, even on a day whose own backup fails.
          If the storage cannot be reached, or our server is down, they are deleted as soon as it is back.
        </li>
        <li>
          Emails go out from our own mail server, over an encrypted connection when your email provider offers one.
          While an email waits to be delivered (at most a day) the mail server holds it with your address, and its
          delivery log and bounce notices keep your address for up to 4 days. These are not encrypted, and only the
          server's administrator can read them.
        </li>
        <li>
          Encryption protects copies of the database and backups. The server itself holds the key, as it must to email
          you.
        </li>
      </ul>

      <h2>Notifications</h2>
      <p>
        If you turn notifications on for an alert, in a browser or in the Android app, your browser gives us a push
        subscription: an address at your browser maker's push service, and two keys. We use it only to send that
        alert's notifications to that device.
      </p>
      <ul>
        <li>
          We keep the push subscription encrypted (AES-256-GCM), with your alert, along with a short name for the device
          (such as "Chrome on Android"), when it was added, and when a notification last went through or failed.
        </li>
        <li>
          Your browser also keeps a random key for this device. We keep only a hash of it, so that the device can ask
          whether its notifications are on, and turn them off, without an account.
        </li>
        <li>
          Notifications reach your device through the push service your browser uses, such as Google's for Chrome and
          the Android app, Mozilla's for Firefox, Apple's for Safari, or Microsoft's for Edge on Windows. They are
          encrypted so the push service cannot read them; it sees that a message was sent to that device, when, and
          how big it was.
        </li>
        <li>
          To stop them, use Turn off on the home page, block notifications for this site in your browser or phone
          settings, unsubscribe, or delete your data.
        </li>
        <li>
          The push subscription is deleted when you turn notifications off, unsubscribe or delete your data, and when
          the push service says it is no longer valid. A device that is never set up is deleted: for an alert you already have, at the first check after 48 hours;
          otherwise 3 days after the last sign-up that asked for it. After you
          turn a device off, a hash of its key is kept for 3 days, so that an older sign-up link cannot turn it back on.
        </li>
        <li>Push subscriptions are not kept in our backups: restoring a backup never turns notifications back on.</li>
      </ul>

      <h2>Deleting your address</h2>
      <p>
        Every alert email has an unsubscribe link. Unsubscribing deletes your address and your choices at once, with
        nothing to ask for or wait on. A sign-up you never confirm deletes itself after 48 hours. The last copies, in
        the backups and the mail server's logs, are gone within 14 days. Backups can stay longer only while their
        storage cannot be reached or our server is down (see above).
      </p>
      <p>
        You can also <a href={`${BASE}delete-data`}>stop alerts and delete your data here</a> before your first alert arrives or if you lose your email links. Enter your address, open the deletion link we email you, and press the button. This deletes your address, choices and waiting alerts and cancels unused sign-up links. We send the same link whether or not an address is subscribed. Anonymous totals and temporary abuse-prevention counters keep their usual retention periods described above.
      </p>

      <h2>Where it is kept</h2>
      <p>
        On our server in Manila, run on Huawei Cloud, and the encrypted backups on Cloudflare R2 storage; both hold it
        only for us. Apart from them, and the alerts themselves, which reach you through your email provider and, for
        notifications, your browser's push service, no one receives your data from us.
      </p>

      <h2>Changes and questions</h2>
      <p>
        Changes to this page are dated here, and every change to the code is public in the{' '}
        <a href={REPO_URL} rel="noreferrer">
          source repository
        </a>
        . Questions can go in an{' '}
        <a href={`${REPO_URL}/issues`} rel="noreferrer">
          issue there
        </a>
        . Issues are public, so please leave your email address out of them.
      </p>
    </article>
  );
}
