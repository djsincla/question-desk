'use strict';
/**
 * The room screen served by the plugin: one QR code, it decodes to a link that joins, and the
 * slide layout the PowerPoint add-in frames works too.
 * Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { BASE, ENGINES, siteUp, adminFrame, callServer, makeSession, removeSession } = require('./helpers');

for (const [name, engine] of ENGINES) {
  test(name + ': the room screen shows one QR code that joins the session', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const sessionName = 'Screen test ' + Date.now();
    let admin;
    try {
      admin = await adminFrame(browser);
      const session = await makeSession(admin, { name: sessionName, heading: 'Ask the panel' });
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
      if (admin) await removeSession(admin, sessionName);
      await browser.close();
    }
  });
}
