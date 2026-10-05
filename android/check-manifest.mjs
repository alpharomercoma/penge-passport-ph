// Checks android/twa-manifest.json, and the generated project when it exists,
// for what notifications need. No network: the live checks are in check-play-release.mjs.
import { existsSync, readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync(new URL('./twa-manifest.json', import.meta.url), 'utf8'));
const fail = (msg) => { console.error(`check-manifest: ${msg}`); process.exit(1); };
if (m.enableNotifications !== true) fail('enableNotifications is not true');
if (m.monochromeIconUrl !== 'https://alphaexperiments.com/pengepassportph/icons/monochrome-512.png') fail('monochromeIconUrl is not the site icon');
if (m.appVersionCode !== 2 || m.appVersion !== '1.1.0') fail('version is not 2 / 1.1.0');
// --project: also the generated project, which android/build.sh regenerates from the manifest.
if (process.argv.includes('--project')) {
  const manifest = new URL('./project/app/src/main/AndroidManifest.xml', import.meta.url);
  if (!existsSync(manifest)) fail('no generated project yet: run android/build.sh first');
  const xml = readFileSync(manifest, 'utf8');
  if (!xml.includes('android.permission.POST_NOTIFICATIONS')) fail('the generated app does not ask for notifications');
  if (!xml.includes('DelegationService')) fail('the generated app has no notification delegation');
}
console.log('check-manifest: ok');
