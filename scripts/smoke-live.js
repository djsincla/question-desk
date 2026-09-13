#!/usr/bin/env node
'use strict';
/**
 * Checks the live deployment the way guests reach it: WebKit set up as an iPhone and
 * Chromium, no Google sign-in, both address forms. Fails if Google shows an error page
 * ("Sorry, unable to open the file at this time") or Question Desk doesn't answer.
 *
 *   QD_DEPLOYMENT_ID=… node scripts/smoke-live.js      (scripts/ship.sh runs this after deploying)
 *
 * It cannot reproduce a browser signed into other Google accounts — that is why room
 * screen and participant links always use the public /macros/s/ address.
 */
const { webkit, chromium, devices } = require('playwright');

const id = process.env.QD_DEPLOYMENT_ID;
const domain = process.env.QD_DOMAIN || '';
if (!id) { console.error('Set QD_DEPLOYMENT_ID (see .deploy.env).'); process.exit(2); }

const checks = [
  ['landing page', '', /Questions welcome/],
  ['room screen', '?view=present&s=ffffffff', /room screen link is not valid/]
];
const bases = [['public', 'https://script.google.com/macros/s/' + id + '/exec']];
if (domain) bases.push(['domain', 'https://script.google.com/a/' + domain + '/macros/s/' + id + '/exec']);

async function pageText(page) {
  let text = '';
  for (const frame of page.frames()) {
    try { text += ' ' + await frame.evaluate(() => (document.body ? document.body.innerText : '')); } catch (err) { /* cross-origin */ }
  }
  return text.replace(/\s+/g, ' ');
}

(async () => {
  let failed = 0;
  for (const [engineName, engine, options] of [['webkit (iPhone)', webkit, devices['iPhone 15']], ['chromium', chromium, {}]]) {
    const browser = await engine.launch();
    const context = await browser.newContext(options);
    const page = await context.newPage();
    for (const [form, base] of bases) {
      for (const [label, query, expected] of checks) {
        let ok = false;
        let text = '';
        for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
          try {
            await page.goto(base + query, { waitUntil: 'networkidle', timeout: 45000 });
            await page.waitForTimeout(2000);
            text = await pageText(page);
            ok = expected.test(text) && !/unable to open the file/i.test(text);
          } catch (err) {
            text = err.message;
          }
          if (!ok && attempt < 3) await page.waitForTimeout(5000);
        }
        console.log((ok ? '  ✓ ' : '  ✗ ') + engineName + ' · ' + form + ' address · ' + label + (ok ? '' : ' — ' + text.trim().slice(0, 120)));
        if (!ok) failed++;
      }
    }
    await browser.close();
  }
  if (failed) { console.error(failed + ' live check(s) failed.'); process.exit(1); }
  console.log('Live deployment answers correctly.');
})();
