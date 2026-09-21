'use strict';
/**
 * A phone asking a question on the WordPress plugin: the participant page joins with the
 * session's link key, sends, and the question is in the queue's data afterwards.
 * Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { devices } = require('playwright');
const { BASE, ENGINES, siteUp, adminFrame, callServer, makeSession, removeSession } = require('./helpers');

for (const [name, engine] of ENGINES) {
  test(name + ': a phone joins with the link and asks a question', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const sessionName = 'Ask test ' + Date.now();
    let admin;
    try {
      admin = await adminFrame(browser);
      const session = await makeSession(admin, { name: sessionName, access: 'link', heading: 'Ask the panel' });
      await callServer(admin, 'setSessionActive', [session.id, true]);

      // A phone: its own browser context, signed into nothing.
      const phone = await browser.newContext(devices['iPhone 13']);
      const page = await phone.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(session.links.participant);
      await page.waitForSelector('#q:not([disabled])');
      // The heading arrives with the session's state, a moment after the box is enabled.
      await page.waitForFunction(() => document.getElementById('heading').textContent === 'Ask the panel');

      const question = 'What is the plan for the waiting list this year?';
      await page.fill('#q', question);
      await page.click('#send');
      await page.waitForSelector('#sent:not([hidden])');
      assert.match(await page.textContent('#sentList'), /waiting list/);
      assert.deepEqual(errors, []);

      const state = await callServer(admin, 'adminState', []);
      const after = state.value.sessions.filter((s) => s.id === session.id)[0];
      assert.equal(after.questionCount, 1, 'the question reached the session');
      await phone.close();
    } finally {
      if (admin) await removeSession(admin, sessionName);
      await browser.close();
    }
  });
}
