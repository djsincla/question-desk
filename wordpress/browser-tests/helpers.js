'use strict';
/**
 * Shared bits for the plugin's browser tests: the local wp-env site, signing in, the Admin
 * page (which is the only way to make a session), and calling the server the way the pages do.
 */
const { chromium, webkit } = require('playwright');

const BASE = process.env.QD_WP_URL || 'http://localhost:8888';
// wp-env's own development account, the same for everyone; never a real site's.
const USER = process.env.QD_WP_USER || 'admin';
const PASS = process.env.QD_WP_PASS || 'password';

const ENGINES = [['chromium', chromium], ['webkit', webkit]];

async function siteUp() {
  try { return (await fetch(BASE + '/questions/')).status === 200; } catch (err) { return false; }
}

/**
 * Signs in and opens the Admin page, answering with its frame. The sign-in is a plain POST
 * rather than filling the form: its cookies land in the same context, and there is no
 * navigation to race (WebKit on a slow runner missed it).
 */
async function adminFrame(browser) {
  const context = await browser.newContext();
  const answer = await context.request.post(BASE + '/wp-login.php', {
    form: { log: USER, pwd: PASS, 'wp-submit': 'Log In', redirect_to: BASE + '/wp-admin/', testcookie: '1' },
    timeout: 60000
  });
  if (!answer.ok()) throw new Error('sign-in failed: ' + answer.status() + ' ' + answer.statusText());
  const page = await context.newPage();
  await page.goto(BASE + '/wp-admin/admin.php?page=question-desk', { timeout: 60000 });
  if (page.url().indexOf('wp-login.php') !== -1) throw new Error('not signed in: ' + page.url());
  // A cold PHP container on a CI runner can take a while for the first admin page.
  const frame = await (await page.waitForSelector('iframe[title="Question Desk"]', { timeout: 60000 })).contentFrame();
  await frame.waitForSelector('#tab-sessions', { state: 'attached', timeout: 60000 });
  return frame;
}

/** One google.script.run call, as any page makes it: { value } or { error }. */
function callServer(frame, fn, args) {
  return frame.evaluate(([name, list]) => new Promise((resolve) => {
    const runner = google.script.run
      .withSuccessHandler((value) => resolve({ value: value }))
      .withFailureHandler((e) => resolve({ error: e.message }));
    runner[name].apply(runner, list);
  }), [fn, args]);
}

/** Makes a session through the Admin page and answers with it. */
async function makeSession(frame, input) {
  const saved = await callServer(frame, 'saveSession', [input]);
  const session = (saved.value ? saved.value.sessions : []).filter((s) => s.name === input.name)[0];
  if (!session) throw new Error('session not saved: ' + JSON.stringify(saved).slice(0, 300));
  return session;
}

/** Deletes it again, so repeated runs don't pile sessions up. */
async function removeSession(frame, name) {
  const state = await callServer(frame, 'adminState', []);
  const mine = (state.value ? state.value.sessions : []).filter((s) => s.name === name)[0];
  if (!mine) return;
  await callServer(frame, 'setSessionActive', [mine.id, false]);
  await callServer(frame, 'deleteSession', [mine.id, name]);
}

module.exports = { BASE, ENGINES, siteUp, adminFrame, callServer, makeSession, removeSession };
