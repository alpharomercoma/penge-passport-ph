// The real alert email, rendered by the server's own template with sample openings (checked 12:02 PM Manila time,
// as the ad's notification says).
//   npx tsx email.mts   (then node email-shot.cjs)
import { writeFileSync } from 'node:fs';
import { alertEmail } from '../../apps/server/src/templates.ts';

const mail = alertEmail({
  openings: [
    { id: 424, name: 'Ilocos Norte (Robinsons Place, San Nicolas)', dates: ['2026-10-20', '2026-10-21', '2026-10-22'], checkedAt: '2026-10-13T04:02:00.000Z' },
    { id: 36, name: 'Dubai (Philippine Consulate General, United Arab Emirates)', dates: ['2026-10-21'], checkedAt: '2026-10-13T03:47:00.000Z' },
  ],
  applicants: 1,
  unsubscribeUrl: 'https://alphaexperiments.com/pengepassportph/unsubscribe',
  manageUrl: 'https://alphaexperiments.com/pengepassportph/',
  lastToday: false,
});
writeFileSync(new URL('./assets/email.html', import.meta.url), mail.html);
console.log('subject:', mail.subject);
