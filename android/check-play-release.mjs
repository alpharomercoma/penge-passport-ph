#!/usr/bin/env node
// Read-only release gate. Never treats the local upload key as proof of Play signing.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const fingerprint = args.includes('--play-sha256') ? option('--play-sha256')?.replace(/:/g, '').toUpperCase() : undefined;
const email = args.includes('--support-email') ? option('--support-email')?.trim().toLowerCase() : undefined;
const failures = [];
const fail = (message) => failures.push(message);
if (!fingerprint || !/^[A-F0-9]{64}$/.test(fingerprint)) fail('Supply the actual Play App signing certificate SHA-256 with --play-sha256.');
if (!email || !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(email)) fail('Supply a monitored public support address with --support-email.');
const manifest = JSON.parse(readFileSync(new URL('./twa-manifest.json', import.meta.url), 'utf8'));
const origin = `https://${manifest.host}`;
const base = new URL(manifest.startUrl, origin).href;
const get = async (url) => {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200) throw new Error(`${url}: HTTP ${response.status} (no redirects permitted)`);
  return response;
};
try {
  const response = await get(`${origin}/.well-known/assetlinks.json`);
  if (!response.headers.get('content-type')?.includes('application/json')) fail('Live assetlinks must be application/json.');
  const links = await response.json();
  if (fingerprint && !links.some((link) => link.relation?.includes('delegate_permission/common.handle_all_urls') && link.target?.package_name === manifest.packageId && link.target.sha256_cert_fingerprints?.some((value) => value.replace(/:/g, '').toUpperCase() === fingerprint))) fail('The actual Play signing certificate is absent from the live assetlinks. Add and deploy it before production.');
  for (const path of ['privacy', 'delete-data', 'manifest.webmanifest']) await get(new URL(path, base));
  const html = await (await get(base)).text();
  const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  if (!script) fail('Live app bundle was not found.');
  else if (email) {
    const bundle = await (await get(new URL(script, base))).text();
    if (!bundle.includes(email) || !bundle.includes('mailto:')) fail('The supplied support address is not in the live app. Publish the privacy/support contact before production.');
  }
  // The status-bar icon notifications use: served, a PNG, 512 square.
  const mono = await get(manifest.monochromeIconUrl);
  if (!mono.headers.get('content-type')?.startsWith('image/png')) fail(`monochromeIconUrl answers ${mono.headers.get('content-type')}`);
  const png = Buffer.from(await mono.arrayBuffer());
  // A real PNG: its signature, then the IHDR chunk that holds the width and height.
  const isPng = png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.toString('latin1', 12, 16) === 'IHDR';
  if (!isPng) fail('monochromeIconUrl is not a PNG');
  else if (png.readUInt32BE(16) !== 512 || png.readUInt32BE(20) !== 512) fail('monochromeIconUrl is not 512x512');
} catch (error) { fail(error.message); }
console.log(JSON.stringify({ packageId: manifest.packageId, site: base, passed: failures.length === 0, failures, remainingManualChecks: ['Match Console support email and Data safety/Government declarations.', 'Install from Play test track and verify TWA, deletion, email confirmation, offline recovery, Back and TalkBack.', 'Review pre-launch report and confirm production access/closed-test requirements.'] }, null, 2));
process.exitCode = failures.length ? 1 : 0;
