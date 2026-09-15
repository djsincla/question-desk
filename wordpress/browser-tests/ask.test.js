'use strict';
/**
 * A phone asking a question on the WordPress plugin: the participant page joins with the
 * session's link key, sends, and the question is in the queue's data afterwards.
 * Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, webkit, devices } = require('playwright');

const BASE = process.env.QD_WP_URL || 'http://localhost:8888';
// wp-env's own development account, the same for everyone; never a real site's.
const USER = process.env.QD_WP_USER || 'admin';
const PASS = process.env.QD_WP_PASS || 'password';

async function siteUp() {
  try { return (await fetch(BASE + '/questions/')).status === 200; } catch (err) { return false; }
}

/** Signs in and drives the Admin page, which is the only way to make a session. */
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
  test(name + ': a phone joins with the link and asks a question', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const sessionName = 'Ask test ' + Date.now();
    let admin;
    try {
      admin = await adminFrame(browser);
      const saved = await callServer(admin, 'saveSession', [{ name: sessionName, access: 'link', heading: 'Ask the panel' }]);
      const session = saved.value.sessions.filter((s) => s.name === sessionName)[0];
      assert.ok(session, JSON.stringify(saved).slice(0, 300));
      await callServer(admin, 'setSessionActive', [session.id, true]);

      // A phone: its own browser context, signed into nothing.
      const phone = await browser.newContext(devices['iPhone 13']);
      const page = await phone.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(session.links.participant);
      await page.waitForSelector('#q:not([disabled])');
      assert.equal(await page.textContent('#heading'), 'Ask the panel');

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
