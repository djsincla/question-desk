'use strict';
/**
 * The room screen served by the plugin: one QR code, it decodes to a link that joins, and the
 * slide layout the PowerPoint add-in frames works too.
 * Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const BASE = process.env.QD_WP_URL || 'http://localhost:8888';
// wp-env's own development account, the same for everyone; never a real site's.
const USER = process.env.QD_WP_USER || 'admin';
const PASS = process.env.QD_WP_PASS || 'password';

async function siteUp() {
  try { return (await fetch(BASE + '/questions/')).status === 200; } catch (err) { return false; }
}

async function adminFrame(browser) {
  const page = await browser.newPage();
  await page.goto(BASE + '/wp-login.php');
  await page.fill('#user_login', USER);
  await page.fill('#user_pass', PASS);
  await Promise.all([page.waitForNavigation(), page.click('#wp-submit')]);
  await page.goto(BASE + '/wp-admin/admin.php?page=question-desk');
  const frame = await (await page.waitForSelector('iframe[title="Question Desk"]')).contentFrame();
  await frame.waitForSelector('#tab-sessions', { state: 'attached' });
  return frame;
}

function callServer(frame, fn, args) {
  return frame.evaluate(([name, list]) => new Promise((resolve) => {
    const runner = google.script.run
      .withSuccessHandler((value) => resolve({ value: value }))
      .withFailureHandler((e) => resolve({ error: e.message }));
    runner[name].apply(runner, list);
  }), [fn, args]);
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(name + ': the room screen shows one QR code that joins the session', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const sessionName = 'Screen test ' + Date.now();
    let admin;
    try {
      admin = await adminFrame(browser);
      const saved = await callServer(admin, 'saveSession', [{ name: sessionName, heading: 'Ask the panel' }]);
      const session = saved.value.sessions.filter((s) => s.name === sessionName)[0];
      assert.ok(session, JSON.stringify(saved).slice(0, 300));
      await callServer(admin, 'setSessionActive', [session.id, true]);

      // A screen in the room: its own context, signed into nothing.
      const room = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await room.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      for (const layout of ['full', 'qr']) {
        await page.goto(session.links.present + (layout === 'qr' ? '&layout=qr' : ''));
        await page.waitForSelector('#code svg', { state: 'attached' });
        await page.waitForTimeout(400);
        const structure = await page.evaluate(() => Array.from(document.getElementById('code').children).map((el) => el.tagName.toLowerCase()));
        assert.deepEqual(structure, ['svg'], layout + ': the QR box holds a single SVG');

        const png = PNG.sync.read(await page.locator('#code').screenshot());
        const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
        assert.ok(decoded, layout + ': the QR code decodes at ' + png.width + 'px');
        assert.match(decoded.data, new RegExp('\\?s=' + session.id + '&t=[a-f0-9]{12}$'), layout + ': ' + decoded.data);

        if (layout === 'full') {
          // The code on the screen is a working way in: follow it as a phone would.
          const phone = await browser.newContext();
          const asking = await phone.newPage();
          await asking.goto(decoded.data);
          await asking.waitForSelector('#q:not([disabled])');
          assert.equal(await asking.textContent('#heading'), 'Ask the panel');
          await phone.close();
        }
      }
      assert.deepEqual(errors, []);
      await room.close();
    } finally {
      // Clean up, so repeated runs don't pile sessions up.
      if (admin) {
        const state = await callServer(admin, 'adminState', []);
        const mine = (state.value ? state.value.sessions : []).filter((s) => s.name === sessionName)[0];
        if (mine) {
          await callServer(admin, 'setSessionActive', [mine.id, false]);
          await callServer(admin, 'deleteSession', [mine.id, sessionName]);
        }
      }
      await browser.close();
    }
  });
}
