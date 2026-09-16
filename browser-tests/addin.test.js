'use strict';
/**
 * The PowerPoint add-in page (docs/addin) in a real browser, with Google and the guest page
 * sites faked by request routing: a guest page whose site refuses to be framed falls back to
 * Google's address, a working guest page stays, and a silent or outdated screen is reloaded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const DOCS = path.join(__dirname, '..', 'docs');
const D = 'AKfycb' + 'x'.repeat(40);
const TAIL = 'view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr';
const GOOGLE = 'https://script.google.com/macros/s/' + D + '/exec?' + TAIL;
const ADDIN = 'https://djsincla.github.io/question-desk/addin/';

let browsers = {};
test.before(async () => { browsers.chromium = await chromium.launch(); browsers.webkit = await webkit.launch(); });
test.after(async () => { for (const b of Object.values(browsers)) await b.close(); });

/** Opens the add-in with a saved link. `google` decides what the fake room screen says. */
async function openAddin(engine, link, google) {
  const context = await browsers[engine].newContext();
  const page = await context.newPage();
  const googleLoads = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const file = (rel, type) => ({ status: 200, contentType: type, body: fs.readFileSync(path.join(DOCS, rel)) });
  await context.route('https://appsforoffice.microsoft.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await context.route(ADDIN + '**', (r) => {
    const rel = new URL(r.request().url()).pathname.replace('/question-desk/', '');
    r.fulfill(file(rel.endsWith('/') ? rel + 'index.html' : rel, rel.endsWith('.js') ? 'text/javascript' : 'text/html'));
  });
  // A site like autismla.org: sends X-Frame-Options, so the browser won't show it in a frame.
  await context.route('https://blocked.example/**', (r) => r.fulfill({
    status: 200, contentType: 'text/html', headers: { 'X-Frame-Options': 'SAMEORIGIN' }, body: '<h1>Guest page</h1>'
  }));
  // A site hosting the real guest page (docs/join).
  await context.route('https://good.example/join/**', (r) => {
    const rel = new URL(r.request().url()).pathname.endsWith('.js') ? 'join/join-url.js' : 'join/index.html';
    r.fulfill(file(rel, rel.endsWith('.js') ? 'text/javascript' : 'text/html'));
  });
  await context.route('https://survey.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Fall survey</h1>' }));
  await context.route('https://script.google.com/**', (r) => {
    googleLoads.push(r.request().url());
    const state = google();
    r.fulfill({
      status: 200, contentType: 'text/html',
      body: '<body style="background:#123">room screen<script>' +
        // Reports once when it loads, like a screen that then hangs.
        (state ? 'top.postMessage({ questionDesk: ' + JSON.stringify(state) + ' }, "*");' : '') +
        '</script></body>'
    });
  });
  await page.clock.install();
  await page.goto(ADDIN + '?room=' + encodeURIComponent(link));
  const frameSrc = () => page.evaluate(() => document.getElementById('screen').getAttribute('src'));
  return { page, context, googleLoads, errors, frameSrc };
}

for (const engine of ['chromium', 'webkit']) {
  test(`${engine}: add-in shows any web page, sandboxed, and explains links it can't show`, async () => {
    const a = await openAddin(engine, 'https://survey.example/fall?ref=slide', () => 'ok');
    try {
      assert.equal(await a.frameSrc(), 'https://survey.example/fall?ref=slide');
      const sandbox = await a.page.getAttribute('#screen', 'sandbox');
      assert.match(sandbox, /allow-scripts/);
      assert.doesNotMatch(sandbox, /top-navigation/);
      const frame = a.page.frames().find((f) => f.url().startsWith('https://survey.example/'));
      await frame.waitForSelector('h1');
      assert.equal(await frame.textContent('h1'), 'Fall survey');
      assert.match(await a.page.textContent('#note'), /doesn’t allow being shown/);
      // Not a Question Desk screen: no fallback, and no reloads for being silent.
      await a.page.clock.runFor(5 * 60000);
      assert.equal(await a.frameSrc(), 'https://survey.example/fall?ref=slide');

      // Change link: a link pasted without its https:// is understood, as copied from a
      // browser's address bar.
      await a.page.click('#gear');
      await a.page.fill('#link', 'survey.example/fall');
      await a.page.click('#setup button[type=submit]');
      assert.equal(await a.frameSrc(), 'https://survey.example/fall');
      // Something that isn't a link at all is explained, not shown.
      await a.page.click('#gear');
      await a.page.fill('#link', 'presentation');
      await a.page.click('#setup button[type=submit]');
      assert.match(await a.page.textContent('#error'), /web address/);
      // And back to a Question Desk slide link: sandbox off, live QR handling on.
      await a.page.fill('#link', GOOGLE);
      await a.page.click('#setup button[type=submit]');
      assert.equal(await a.frameSrc(), GOOGLE);
      assert.equal(await a.page.getAttribute('#screen', 'sandbox'), null);
      assert.deepEqual(a.errors, []);
    } finally { await a.context.close(); }
  });

  test(`${engine}: add-in falls back to Google's address when a custom guest page can't be framed`, async () => {
    const link = 'https://blocked.example/qa/?d=' + D + '&view=present&s=1a2b3c4d&r=0123456789abcdef';
    const a = await openAddin(engine, link, () => 'ok');
    try {
      assert.equal(await a.frameSrc(), 'https://blocked.example/qa/?d=' + D + '&' + TAIL, 'tries the guest page first');
      await a.page.clock.runFor(10000);
      assert.equal(await a.frameSrc(), 'https://blocked.example/qa/?d=' + D + '&' + TAIL, 'gives it time to load');
      await a.page.clock.runFor(12000);
      assert.equal(await a.frameSrc(), GOOGLE, 'then shows the slide from Google');
      assert.match(await a.page.textContent('#note'), /guest page didn’t load/);
      // Once the Google screen reports in, it stays put.
      await a.page.waitForTimeout(300);
      await a.page.clock.runFor(2 * 60000);
      assert.equal(await a.frameSrc(), GOOGLE);
      assert.equal(a.googleLoads.length, 1, 'no reloads while the screen reports in');
      assert.deepEqual(a.errors, []);
    } finally { await a.context.close(); }
  });

  test(`${engine}: add-in keeps a working guest page, and reloads a screen that goes silent or is outdated`, async () => {
    const link = 'https://good.example/join/?d=' + D + '&view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr';
    let state = 'ok';
    const a = await openAddin(engine, link, () => state);
    try {
      await a.page.waitForTimeout(500);
      await a.page.clock.runFor(30000);
      assert.equal(await a.frameSrc(), link, 'guest page kept: its room screen reported in');
      assert.equal(a.googleLoads.length, 1);
      assert.equal(await a.page.isHidden('#note'), true);

      // The screen inside stops reporting (a sleeping laptop, dropped wifi): reloaded after three minutes.
      await a.page.clock.runFor(3 * 60000);
      await a.page.waitForTimeout(300);
      assert.equal(a.googleLoads.length, 2, 'reloaded after going silent');
      assert.equal(await a.frameSrc(), link, 'still the guest page');

      // A newer Question Desk version is live: the screen says it's outdated and is reloaded,
      // but only once in ten minutes, however often it says so.
      state = 'outdated';
      await a.page.clock.runFor(3 * 60000);
      await a.page.waitForTimeout(300);
      await a.page.clock.runFor(4000);
      await a.page.waitForTimeout(300);
      assert.equal(a.googleLoads.length, 4, 'silent reload, then the outdated reload');
      await a.page.clock.runFor(60000);
      await a.page.waitForTimeout(300);
      assert.equal(a.googleLoads.length, 4, 'no reload loop');
      assert.deepEqual(a.errors, []);
    } finally { await a.context.close(); }
  });
}
