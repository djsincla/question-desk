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
// Sessions default to this project's GitHub Pages copy, so check it even when none is configured.
const guestPage = process.env.QD_GUEST_PAGE || 'https://djsincla.github.io/question-desk/join/';
const fs = require('fs');
const path = require('path');
const expectedVersion = (fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8').match(/version: '([^']+)'/) || [])[1];

/** Finds the Apps Script page's own frame (it's nested inside Google's frames). */
async function appFrame(page) {
  for (const frame of page.frames()) {
    try { if (await frame.evaluate(() => typeof BOOT !== 'undefined')) return frame; } catch (err) { /* not ready */ }
  }
  return null;
}

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

    // The new version is the one serving, and a server call from the page gets an answer.
    // Loading pages alone would pass even if the redeploy did nothing or google.script.run broke.
    {
      let detail = '';
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          await page.goto(bases[0][1], { waitUntil: 'networkidle', timeout: 45000 });
          const frame = await appFrame(page);
          if (!frame) { detail = 'page data not found'; continue; }
          const version = await frame.evaluate(() => BOOT.version);
          const state = await frame.evaluate(() => new Promise((resolve) => {
            google.script.run.withSuccessHandler(resolve).withFailureHandler((e) => resolve({ error: String(e && e.message || e) }))
              .getSessionState('ffffffff', '');
          }));
          ok = version === expectedVersion && state && state.found === false;
          detail = 'version ' + version + ' (expected ' + expectedVersion + '), server call ' + JSON.stringify(state).slice(0, 80);
        } catch (err) { detail = err.message; }
        if (!ok && attempt < 3) await page.waitForTimeout(5000);
      }
      console.log((ok ? '  ✓ ' : '  ✗ ') + engineName + ' · version ' + expectedVersion + ' serving, server calls answer' + (ok ? '' : ' — ' + detail));
      if (!ok) failed++;
    }
    if (guestPage) {
      const url = guestPage + '?d=' + id + '&view=present&s=ffffffff';
      let ok = false;
      let text = '';
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
          await page.waitForTimeout(2500);
          text = await pageText(page);
          ok = /room screen link is not valid/.test(text) && !/unable to open the file/i.test(text);
        } catch (err) { text = err.message; }
        if (!ok && attempt < 3) await page.waitForTimeout(5000);
      }
      console.log((ok ? '  ✓ ' : '  ✗ ') + engineName + ' · guest page · room screen' + (ok ? '' : ' — ' + text.trim().slice(0, 120)));
      if (!ok) failed++;
    }
    await browser.close();
  }
  if (failed) { console.error(failed + ' live check(s) failed.'); process.exit(1); }
  console.log('Live deployment answers correctly.');
})();
