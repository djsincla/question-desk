'use strict';
/**
 * The WordPress plugin in a real browser, against the local wp-env site (npm run wp:start).
 * Skips when the site isn't running, so the Apps Script suite never depends on Docker.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');

const BASE = process.env.QD_WP_URL || 'http://localhost:8888';

async function siteUp() {
  try { return (await fetch(BASE + '/questions/')).status === 200; } catch (err) { return false; }
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(name + ': the WordPress landing page renders styled, and google.script.run reaches the plugin', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(BASE + '/questions/');
      await page.waitForSelector('main');
      const look = await page.evaluate(() => ({
        css: Array.from(document.querySelectorAll('style')).reduce((n, el) => n + el.textContent.length, 0),
        background: getComputedStyle(document.body).backgroundColor,
        join: (document.getElementById('joinEn') || {}).textContent || '',
        shared: typeof $ === 'function'
      }));
      assert.ok(look.css > 3000, 'styles: ' + look.css);
      assert.notEqual(look.background, 'rgba(0, 0, 0, 0)');
      assert.match(look.join, /scan the code/);
      assert.equal(look.shared, true, 'Scripts.html section');

      // The same calls the pages make.
      const answer = await page.evaluate(() => new Promise((resolve) => {
        google.script.run.withSuccessHandler((v) => resolve({ value: v })).withFailureHandler((e) => resolve({ error: e.message })).getSessionState('ffffffff', '');
      }));
      assert.deepEqual(answer, { value: { found: false } });
      const refused = await page.evaluate(() => new Promise((resolve) => {
        const runner = google.script.run.withSuccessHandler(() => resolve({ value: true })).withFailureHandler((e) => resolve({ error: e.message, isError: e instanceof Error }));
        runner['deleteEverything'].apply(runner, []);
      }));
      assert.deepEqual(refused, { error: 'Unknown function deleteEverything.', isError: true });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
