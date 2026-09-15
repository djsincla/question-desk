'use strict';
/**
 * The Admin page inside WordPress: the same Admin.html the Apps Script version serves, drawn
 * from WordPress data. Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');

const BASE = process.env.QD_WP_URL || 'http://localhost:8888';
// wp-env's own development account, the same for everyone; never a real site's.
const USER = process.env.QD_WP_USER || 'admin';
const PASS = process.env.QD_WP_PASS || 'password';

async function siteUp() {
  try { return (await fetch(BASE + '/questions/')).status === 200; } catch (err) { return false; }
}

async function signIn(page) {
  await page.goto(BASE + '/wp-login.php');
  await page.fill('#user_login', USER);
  await page.fill('#user_pass', PASS);
  await Promise.all([page.waitForNavigation(), page.click('#wp-submit')]);
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(name + ': the Admin page draws inside WordPress and saves a session', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await signIn(page);
      await page.goto(BASE + '/wp-admin/admin.php?page=question-desk');
      const frame = await (await page.waitForSelector('iframe[title="Question Desk"]')).contentFrame();
      await frame.waitForSelector('#tab-sessions', { state: 'attached' });

      const look = await frame.evaluate(() => ({
        css: Array.from(document.querySelectorAll('style')).reduce((n, el) => n + el.textContent.length, 0),
        background: getComputedStyle(document.body).backgroundColor,
        shared: typeof $ === 'function',
        me: (BOOT.state || {}).me || '',
        tabs: Array.from(document.querySelectorAll('.tabs button')).map((el) => el.textContent.trim())
      }));
      assert.ok(look.css > 3000, 'styles: ' + look.css);
      assert.notEqual(look.background, 'rgba(0, 0, 0, 0)');
      assert.equal(look.shared, true, 'Scripts.html section');
      assert.match(look.me, /@/, 'signed in as ' + look.me);
      assert.ok(look.tabs.includes('Sessions'), 'tabs: ' + look.tabs.join(', '));

      // A round trip through the REST transport: save a session, then find it in a fresh state.
      const name = 'Browser test ' + Date.now();
      const saved = await frame.evaluate((sessionName) => new Promise((resolve) => {
        google.script.run
          .withSuccessHandler((state) => resolve({ names: state.sessions.map((s) => s.name) }))
          .withFailureHandler((e) => resolve({ error: e.message }))
          .saveSession({ name: sessionName, heading: 'Ask us anything' });
      }), name);
      assert.ok(saved.names && saved.names.includes(name), JSON.stringify(saved));

      const again = await frame.evaluate(() => new Promise((resolve) => {
        google.script.run.withSuccessHandler((state) => resolve(state.sessions[0])).withFailureHandler((e) => resolve({ error: e.message })).adminState();
      }));
      assert.equal(again.name, name, 'the newest session is on top');
      assert.match(again.links.present, /view=present&s=[a-f0-9]{8}&r=[a-f0-9]{16}/);

      // Clean up, so repeated runs don't pile sessions up.
      const left = await frame.evaluate((session) => new Promise((resolve) => {
        google.script.run
          .withSuccessHandler((state) => resolve(state.sessions.map((s) => s.name)))
          .withFailureHandler((e) => resolve({ error: e.message }))
          .deleteSession(session.id, session.name);
      }), { id: again.id, name: name });
      assert.ok(Array.isArray(left) && !left.includes(name), JSON.stringify(left));
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
