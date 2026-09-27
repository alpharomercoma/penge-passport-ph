// The real alert email, rendered by the server's own template with sample openings.
//   npx tsx email.mts   (then node email-shot.cjs)
import { writeFileSync } from 'node:fs';
import { alertEmail } from '../../apps/server/src/templates.ts';

const mail = alertEmail({
  openings: [
    { id: 12, name: 'Baguio (SM City Baguio)', dates: ['2026-10-07', '2026-10-08', '2026-10-12'] },
    { id: 36, name: 'Dubai (Philippine Consulate General, United Arab Emirates)', dates: ['2026-10-06'] },
  ],
  applicants: 1,
  unsubscribeUrl: 'https://alphaexperiments.com/pengepassportph/unsubscribe',
  manageUrl: 'https://alphaexperiments.com/pengepassportph/',
  lastToday: false,
});
writeFileSync(new URL('./assets/email.html', import.meta.url), mail.html);
console.log('subject:', mail.subject);
