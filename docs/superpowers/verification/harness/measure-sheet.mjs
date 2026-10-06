import puppeteer from 'puppeteer-core';
const t = (p, ms = 15000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
const b = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
let page;
for (const p of await b.pages()) {
  if (p.url().includes('localhost:4173') && (await t(p.evaluate(() => document.visibilityState), 3000).catch(() => '')) === 'visible') page = p;
}
if (!page) throw new Error('no visible page on localhost:4173');
const out = await t(page.evaluate(async () => {
  const probe = (u) => { const d = document.createElement('div'); d.style.cssText = `position:fixed;top:0;height:${u};width:1px`; document.body.append(d); const h = d.getBoundingClientRect().height; d.remove(); return Math.round(h); };
  [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Email alerts')).click();
  await new Promise((r) => setTimeout(r, 1200));
  document.activeElement?.blur?.();
  await new Promise((r) => setTimeout(r, 600));
  const s = document.querySelector('.sheet').getBoundingClientRect();
  const head = document.querySelector('.sheet-head').getBoundingClientRect();
  const lvh = probe('100lvh');
  return {
    width: innerWidth, innerHeight, visualViewport: Math.round(visualViewport.height),
    vh: probe('100vh'), svh: probe('100svh'), lvh, dvh: probe('100dvh'),
    sheet: { top: Math.round(s.top), bottom: Math.round(s.bottom), height: Math.round(s.height), maxHeight: getComputedStyle(document.querySelector('.sheet')).maxHeight },
    headerTop: Math.round(head.top), old92vh: Math.round(0.92 * lvh), new92dvh: Math.round(0.92 * probe('100dvh')),
  };
}));
console.log(JSON.stringify(out, null, 1));
b.disconnect();
