// Changes to the Android project that Bubblewrap cannot express, made by build.sh after
// every `bubblewrap update` (which regenerates the project). Each fails loudly if Bubblewrap
// changes the file it edits, rather than letting a build go out without it or with a
// conflicting definition.
//   node android/patch.cjs <project dir> <twa-manifest.json>
const fs = require('fs');
const path = require('path');

const [project, manifestFile] = process.argv.slice(2);
const main = path.join(project, 'app/src/main');
const { packageId } = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

/**
 * Adds `exact` to a file with `apply`. Done already when the file has `exact`; an error when
 * it has `marker` (some other version of the same thing) or when `apply` cannot place it.
 */
function patch(relative, { exact, marker }, apply) {
  const file = path.join(main, relative);
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(exact)) return;
  if (text.includes(marker)) throw new Error(`${relative}: already has a different ${marker}`);
  const next = apply(text);
  if (!next.includes(exact)) throw new Error(`${relative}: not the shape this patch expects`);
  fs.writeFileSync(file, next);
}

// The launcher icon's monochrome layer, for Android 13+ themed icons. Bubblewrap uses a
// monochrome icon only for notifications.
const MONOCHROME = '<monochrome android:drawable="@drawable/ic_launcher_monochrome" />';
patch('res/mipmap-anydpi-v26/ic_launcher.xml', { exact: MONOCHROME, marker: '<monochrome' }, (xml) =>
  xml.replace('</adaptive-icon>', `    ${MONOCHROME}\n</adaptive-icon>`),
);

// The splash image at its own size, but shrunk to fit a window shorter than it (split screen,
// a small free-form window) instead of cropped: the helper library's default is CENTER.
const SCALE = `    @Override
    protected android.widget.ImageView.ScaleType getSplashImageScaleType() {
        return android.widget.ImageView.ScaleType.CENTER_INSIDE;
    }
`;
patch(`java/${packageId.replace(/\./g, '/')}/LauncherActivity.java`, { exact: SCALE, marker: 'getSplashImageScaleType' }, (java) => {
  if (!java.includes('extends com.google.androidbrowserhelper.trusted.LauncherActivity')) return java;
  const end = java.lastIndexOf('}');
  return `${java.slice(0, end)}\n${SCALE}}\n`;
});
