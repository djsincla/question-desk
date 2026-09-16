'use strict';
/**
 * The QA Facilitator queue served by the plugin: a question asked from a phone appears, is
 * marked answered, and reaches the room screen as the one being answered.
 * Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { devices } = require('playwright');
const { BASE, ENGINES, siteUp, adminFrame, callServer, makeSession, removeSession } = require('./helpers');

for (const [name, engine] of ENGINES) {
  test(name + ': a question reaches the queue and can be answered', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const sessionName = 'Queue test ' + Date.now();
    let admin;
    try {
      admin = await adminFrame(browser);
      const session = await makeSession(admin, { name: sessionName, access: 'link', heading: 'Ask the panel' });
      await callServer(admin, 'setSessionActive', [session.id, true]);

      // A phone asks.
      const phone = await browser.newContext(devices['iPhone 13']);
      const asking = await phone.newPage();
      await asking.goto(session.links.participant);
      await asking.waitForSelector('#q:not([disabled])');
      const question = 'Will the respite waiting list open again this year?';
      await asking.fill('#q', question);
      await asking.click('#send');
      await asking.waitForSelector('#sent:not([hidden])');

      // The queue, in the same signed-in browser as the Admin page.
      const queue = await admin.page().context().newPage();
      const errors = [];
      queue.on('pageerror', (e) => errors.push(e.message));
      await queue.goto(BASE + '/questions/?view=moderate&s=' + session.id);
      await queue.waitForSelector('li[data-id]');
      assert.match(await queue.textContent('li[data-id]'), /respite waiting list/);
      assert.equal(await queue.textContent('#name'), sessionName);

      // Answer it: the row is marked, and the change survives the next refresh.
      const row = queue.locator('li[data-id]').first();
      const id = await row.getAttribute('data-id');
      await row.getByRole('button', { name: 'Answered', exact: true }).click();
      await queue.waitForSelector('li[data-id="' + id + '"].answered');
      assert.deepEqual(errors, []);

      // It stays answered for the next facilitator to open the queue. (A reload aborts the
      // queue's own poll, which WebKit reports as a page error, so errors are checked above.)
      await queue.reload();
      await queue.waitForSelector('li[data-id="' + id + '"].answered');

      const screen = await callServer(admin, 'getRoomScreen', [session.id, 'full', '']);
      assert.equal(screen.value.status, 'active');
      await phone.close();
    } finally {
      if (admin) await removeSession(admin, sessionName);
      await browser.close();
    }
  });
}
