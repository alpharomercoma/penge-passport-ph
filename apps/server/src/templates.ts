// Plain words, a text part and a matching HTML part, no images, no trackers,
// no link shorteners: the things spam filters look at besides the DNS records.
import { formatDate, type Pace, shortName } from '@penge/contracts';
import { DISPLAY_NAME } from 'penge-passport-ph';
import type { DailyStats } from './stats.ts';

export { formatDate, shortName };

export const BOOKING_URL = 'https://passport.gov.ph/appointment';

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

export interface SiteRef {
  id: number;
  name: string;
}

export interface Opening extends SiteRef {
  dates: string[];
  /** Latest successful office calendar lookup, not the email send time. */
  checkedAt?: string | null;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);

function listSubject(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

function page(title: string, body: string, footer: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px 16px;background:#f5f7f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17201b;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dfe5e2;border-radius:10px;padding:24px">
<p style="margin:0 0 18px;font-weight:800;font-size:18px;letter-spacing:-0.3px">PengePassport<span style="color:#4f5b55">PH</span></p>
${body}
</div>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#4f5b55">${footer}</p>
</body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#17201b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block;font-weight:700">${esc(label)}</a></p>`;

const UNOFFICIAL = `${DISPLAY_NAME} is a free, unofficial service, not run by or affiliated with the DFA.`;

/** How often a person hears from us, in their words. */
export const PACE_PROMISE: Record<Pace, string> = {
  hourly: 'at most once an hour, with everything new since the last email',
  asap: 'as soon as a check finds dates (one email per check; checks run every 5 minutes), with everything new since the last email',
};

export function confirmationEmail(input: { confirmUrl: string; deletionUrl?: string; sites: SiteRef[]; applicants: number; pace: Pace }): Rendered {
  const names = input.sites.map((s) => s.name);
  const often = `We email ${PACE_PROMISE[input.pace]}.`;
  const text = [
    `Someone, hopefully you, asked ${DISPLAY_NAME} to email this address when passport appointment dates open for ${people(input.applicants)} at:`,
    '',
    ...names.map((n) => `  - ${n}`),
    '',
    often,
    '',
    'To start the alerts, open this link and press Confirm:',
    input.confirmUrl,
    '',
    'The link works for 48 hours. If this was not you, ignore this email: nothing will be sent.',
    ...(input.deletionUrl ? ['', `To stop alerts or delete your address, even before your first alert: ${input.deletionUrl}`] : []),
    '',
    UNOFFICIAL,
  ].join('\n');
  const html = page(
    'Confirm your alerts',
    `<p style="margin:0 0 12px">Someone, hopefully you, asked us to email this address when passport appointment dates open for ${esc(people(input.applicants))} at:</p>
<ul style="margin:0 0 12px;padding-left:20px">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
<p style="margin:0 0 12px">${esc(often)}</p>
${button(input.confirmUrl, 'Confirm alerts')}
<p style="margin:0;font-size:14px;color:#4f5b55">The link works for 48 hours. If this was not you, ignore this email: nothing will be sent.</p>`,
    `${esc(UNOFFICIAL)}${input.deletionUrl ? `<br><a href="${esc(input.deletionUrl)}">Stop alerts and delete your address</a>` : ''}`,
  );
  return { subject: `Confirm your ${DISPLAY_NAME} alerts`, text, html };
}

export function deletionEmail(input: { deletionUrl: string }): Rendered {
  const intro = 'Someone requested a link to stop PengePassportPH alerts and delete this email address and its alert choices. We send the same link whether or not this address is subscribed.';
  const note = 'Open the link and press Delete my alert data. The link works for 48 hours. If this was not you, ignore this email: nothing changes.';
  const retained = 'Deletion also cancels unused sign-up links. The last copies in encrypted backups and mail-server logs are gone within 14 days. Anonymous totals and temporary abuse-prevention counters are retained as described in our privacy policy.';
  return {
    subject: 'Delete your PengePassportPH alert data',
    text: `${intro}\n\n${note}\n${input.deletionUrl}\n\n${retained}\n\n${UNOFFICIAL}`,
    html: page('Delete your alert data', `<p>${esc(intro)}</p>${button(input.deletionUrl, 'Review deletion request')}<p>${esc(note)}</p><p>${esc(retained)}</p>`, esc(UNOFFICIAL)),
  };
}

function checkTime(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'Office calendar check time unavailable';
  const time = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(new Date(iso));
  return `Office calendar checked: ${time} (Manila time, UTC+8)`;
}

const UNSUBSCRIBE_LABEL = 'Already booked a slot? Unsubscribe';

export function alertEmail(input: {
  openings: Opening[];
  applicants: number;
  unsubscribeUrl: string;
  manageUrl: string;
  /** True when this is the last alert allowed today. */
  lastToday: boolean;
}): Rendered {
  const names = input.openings.map((o) => shortName(o.name));
  const subject = `Passport dates open: ${listSubject(names)}`;
  const capNote = input.lastToday ? 'This is your last alert today; alerts resume tomorrow (Manila time).' : '';
  const text = [
    `New appointment dates opened for ${people(input.applicants)}:`,
    '',
    ...input.openings.flatMap((o) => [o.name, checkTime(o.checkedAt), ...o.dates.map((d) => `  - ${formatDate(d)}`), '']),
    `Book on the DFA site: ${BOOKING_URL}`,
    'Dates go fast, and they may already be taken. We never book or hold a slot for you.',
    ...(capNote ? ['', capNote] : []),
    '',
    '--',
    `You asked ${DISPLAY_NAME} for these alerts. Change your offices: ${input.manageUrl}`,
    `${UNSUBSCRIBE_LABEL}: ${input.unsubscribeUrl}`,
    UNOFFICIAL,
  ].join('\n');
  const html = page(
    subject,
    `<p style="margin:0 0 16px">New appointment dates opened for ${esc(people(input.applicants))}:</p>
${input.openings
  .map(
    (o) => `<p style="margin:0 0 4px;font-weight:600">${esc(o.name)}</p>
<p style="margin:0 0 8px;font-size:13px;color:#4f5b55">${esc(checkTime(o.checkedAt))}</p>
<ul style="margin:0 0 16px;padding-left:20px">${o.dates.map((d) => `<li>${esc(formatDate(d))}</li>`).join('')}</ul>`,
  )
  .join('\n')}
${button(BOOKING_URL, 'Book on the DFA site')}
<p style="margin:0;font-size:14px;color:#4f5b55">Dates go fast, and they may already be taken. We never book or hold a slot for you.</p>
${button(input.unsubscribeUrl, UNSUBSCRIBE_LABEL)}
${capNote ? `<p style="margin:12px 0 0;font-size:14px;color:#4f5b55">${esc(capNote)}</p>` : ''}`,
    `You asked ${esc(DISPLAY_NAME)} for these alerts. <a href="${esc(input.manageUrl)}" style="color:#4f5b55">Change your offices</a> · <a href="${esc(input.unsubscribeUrl)}" style="color:#4f5b55">Unsubscribe</a><br>${esc(UNOFFICIAL)}`,
  );
  return { subject, text, html };
}

/** The operator's morning email: yesterday in numbers. */
export function dailyStatsEmail(stats: DailyStats): Rendered {
  const c = stats.counts;
  const manilaTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
  const partial = stats.partialFrom
    ? `Counting started at ${manilaTime(stats.partialFrom)}, so this is part of the day.`
    : '';
  const top = stats.topOffices.map((o) => `${shortName(o.name)} (${o.views})`).join(', ');
  const sections: [string, [string, string][]][] = [
    [
      'Visitors',
      [
        ['People who visited (estimated, no cookies)', String(stats.visitors)],
        ['Of them, looked at posts abroad', String(stats.abroadVisitors)],
        ['Offices opened', String(c.officeViews)],
        ['Group sizes checked', String(c.groupChecks)],
        ['Days tapped for their hours', String(c.hourLookups)],
        ...(top ? ([['Opened most', top]] as [string, string][]) : []),
      ],
    ],
    [
      'Alerts',
      [
        ['Confirmation emails sent', String(c.confirmEmails)],
        ['New subscribers', String(c.confirmed)],
        ['Changed their offices', String(c.updated)],
        ['Unsubscribed', String(c.unsubscribed)],
        ['Subscribers now', String(stats.subscribers)],
        ['Alerts sent', String(c.alertsSent)],
        ['Alerts held back by the daily cap', String(c.alertsCapped)],
      ],
    ],
    [
      'Checker',
      [
        ['Checks run', `${c.runs} (${c.healthyRuns} healthy)`],
        ['New dates found, for one person', String(c.datesOpened)],
      ],
    ],
  ];
  const where = `The same numbers are in R2 at stats/v1/date=${stats.day}/stats.json.`;
  const day = formatDate(stats.day);
  const subject = `${DISPLAY_NAME}, ${day}: ${stats.visitors} ${stats.visitors === 1 ? 'visitor' : 'visitors'}, ${c.confirmed} new ${c.confirmed === 1 ? 'subscriber' : 'subscribers'}`;
  const text = [
    `${DISPLAY_NAME} on ${day} (Manila time).`,
    ...(partial ? [partial] : []),
    '',
    ...sections.flatMap(([title, rows]) => [title, ...rows.map(([label, value]) => `  ${label}: ${value}`), '']),
    where,
  ].join('\n');
  const html = page(
    subject,
    `<p style="margin:0 0 16px">${esc(DISPLAY_NAME)} on ${esc(day)} (Manila time).${partial ? ` ${esc(partial)}` : ''}</p>
${sections
  .map(
    ([title, rows]) => `<p style="margin:0 0 6px;font-weight:700">${esc(title)}</p>
<table style="width:100%;border-collapse:collapse;margin:0 0 18px;font-size:15px">${rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:4px 0;border-bottom:1px solid #dfe5e2">${esc(label)}</td><td style="padding:4px 0 4px 12px;border-bottom:1px solid #dfe5e2;text-align:right;font-weight:600">${esc(value)}</td></tr>`,
      )
      .join('')}</table>`,
  )
  .join('\n')}
<p style="margin:0;font-size:14px;color:#4f5b55">${esc(where)}</p>`,
    'Sent to whoever runs this server (STATS_EMAIL in /etc/penge/server.env). Visitors are counted without cookies or stored addresses.',
  );
  return { subject, text, html };
}
