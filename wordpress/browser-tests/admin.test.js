'use strict';
/**
 * The Admin page inside WordPress: the same Admin.html the Apps Script version serves, drawn
 * from WordPress data. Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, ENGINES, siteUp, adminFrame, callServer, makeSession, removeSession } = require('./helpers');

for (const [name, engine] of ENGINES) {
  test(name + ': the Admin page draws inside WordPress and saves a session', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const sessionName = 'Browser test ' + Date.now();
    let admin;
    try {
      admin = await adminFrame(browser);
      const look = await admin.evaluate(() => ({
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
      const session = await makeSession(admin, { name: sessionName, heading: 'Ask us anything' });
      const again = await callServer(admin, 'adminState', []);
      const newest = again.value.sessions[0];
      assert.equal(newest.name, sessionName, 'the newest session is on top');
      assert.equal(newest.id, session.id);
      assert.match(newest.links.present, /view=present&s=[a-f0-9]{8}&r=[a-f0-9]{16}/);
    } finally {
      if (admin) await removeSession(admin, sessionName);
      await browser.close();
    }
  });
}
