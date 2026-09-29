// Renders the app's icons from public/favicon.svg (the calendar with one green day):
// node apps/web/scripts/icons.mjs. The PNGs are committed; rerun after changing the mark.
//   icons/icon-{192,512}.png    "any": the mark on a white rounded square
//   icons/maskable-512.png       Android adaptive icon: full bleed, mark inside the safe circle
//   icons/apple-touch-icon.png   iOS home screen (it rounds the corners itself)
//   android/res/drawable-*/splash.png   the Android app's splash (see below)
// Google Play's icon is rendered with the store's other graphics (marketing/play-store/capture.cjs).
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..', '..');
// The light colours only: an icon is not re-rendered for dark mode.
const mark = readFileSync(join(web, 'public', 'favicon.svg'), 'utf8').replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/, '');

const icons = [
  { file: join(web, 'public/icons/icon-192.png'), size: 192, markShare: 0.74, radius: 0.22 },
  { file: join(web, 'public/icons/icon-512.png'), size: 512, markShare: 0.74, radius: 0.22 },
  // Adaptive icons keep only the circle of 80% of the width: the mark stays well inside it.
  { file: join(web, 'public/icons/maskable-512.png'), size: 512, markShare: 0.56, radius: 0 },
  { file: join(web, 'public/icons/apple-touch-icon.png'), size: 180, markShare: 0.7, radius: 0 },
  // The Android app's splash: the icon itself, its corners transparent, at the sizes
  // Bubblewrap uses per density. Its background is a colour that follows dark mode
  // (android/res/values-night), but the image is one for both: the helper library saves
  // it on the first launch and reuses it until the app is updated, whatever the mode.
  // On white the tile disappears; on the dark background it is the app's icon.
  ...[
    ['mdpi', 300],
    ['hdpi', 450],
    ['xhdpi', 600],
    ['xxhdpi', 900],
    ['xxxhdpi', 1200],
  ].map(([density, size]) => ({ file: join(repo, `android/res/drawable-${density}/splash.png`), size, markShare: 0.74, radius: 0.22 })),
];

const browser = await chromium.launch();
const page = await browser.newPage({ colorScheme: 'light' });
for (const { file, size, markShare, radius } of icons) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * markShare);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;background:#fff;border-radius:${Math.round(size * radius)}px;display:grid;place-items:center">
${mark.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: radius > 0 });
  console.log('wrote', file.slice(repo.length + 1));
}
await browser.close();
