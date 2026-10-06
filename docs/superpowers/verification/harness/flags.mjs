import puppeteer from 'puppeteer-core';
const want = process.argv[2]; // 'on' | 'off' | 'show'
const b = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
const p = await b.newPage();
await p.goto('chrome://flags/#enable-command-line-on-non-rooted-devices', { waitUntil: 'load' }).catch((e) => console.log('goto', e.message));
await new Promise((r) => setTimeout(r, 2000));
const state = await p.evaluate(() => {
  const root = document.querySelector('flags-app')?.shadowRoot ?? document;
  const exp = [...root.querySelectorAll('flags-experiment')].find((e) => e.id === 'enable-command-line-on-non-rooted-devices' || e.getAttribute('id') === 'enable-command-line-on-non-rooted-devices');
  const sel = exp?.shadowRoot?.querySelector('select');
  return { found: !!exp, value: sel?.value ?? null, options: sel ? [...sel.options].map((o) => o.value) : [] };
}).catch((e) => ({ err: e.message }));
console.log(JSON.stringify(state));
if (want !== 'show' && state.found) {
  const r = await p.evaluate((on) => {
    const root = document.querySelector('flags-app').shadowRoot;
    const exp = [...root.querySelectorAll('flags-experiment')].find((e) => e.id === 'enable-command-line-on-non-rooted-devices');
    const sel = exp.shadowRoot.querySelector('select');
    sel.value = [...sel.options].map((o) => o.value).find((v) => (on ? /enabled/i.test(v) : /default/i.test(v)));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  }, want === 'on');
  console.log('set', r);
}
await p.close();
b.disconnect();
