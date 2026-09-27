// Writes packages/penge-passport-ph/README.md from the repository README, with
// every relative link made absolute, because npm shows the README away from
// the repository. Runs on `npm pack` / `npm publish` (prepack).
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'https://github.com/alpharomercoma/penge-passport-ph';
const root = new URL('../', import.meta.url);
const relative = (url) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url);
const abs = (url, image) => `${REPO}/${image ? 'raw' : 'blob'}/main/${url.replace(/^\.\//, '')}`;

const readme = readFileSync(new URL('README.md', root), 'utf8')
  // Markdown links and images: [text](url) and ![alt](url)
  .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (m, bang, text, url) =>
    relative(url) ? `${bang}[${text}](${abs(url, bang === '!')})` : m,
  )
  // HTML attributes in the header
  .replace(/\b(src|srcset|href)="([^"]+)"/g, (m, attr, url) =>
    relative(url) ? `${attr}="${abs(url, attr !== 'href')}"` : m,
  );

writeFileSync(new URL('packages/penge-passport-ph/README.md', root), readme);
