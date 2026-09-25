'use strict';
/**
 * The guest page (docs/join) hosted on another site, framing this WordPress Question Desk: the
 * same shape of link the Apps Script version uses. The wrapper is served from a different
 * origin, so this also proves the plugin's pages may be framed by another site.
 * Needs the local wp-env site (npm run wp:start); skips without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BASE, ENGINES, siteUp, adminFrame, callServer, makeSession, removeSession } = require('./helpers');

const JOIN = path.join(__dirname, '..', '..', 'docs', 'join');
// The organization's own site, hosting its copy of the guest page, and its WordPress on https
// (the guest page only ever frames https). Both are served from the local wp-env site below.
const GUEST = 'https://guest.example/qa/';
const SITE = 'https://site.example/questions/';

/** Serves docs/join at GUEST with its site filled in, and SITE from the local WordPress. */
async function hostGuestPage(context) {
  await context.route(GUEST + '**', (route) => {
    const file = route.request().url().endsWith('.js') ? 'join-url.js' : 'index.html';
    let body = fs.readFileSync(path.join(JOIN, file), 'utf8');
    if ('index.html' === file) {
      body = body.replace('data-site=""', 'data-site="' + SITE + '"');
    }
    route.fulfill({ status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : 'text/html', body });
  });
  await context.route(SITE.replace(/\/questions\/$/, '') + '/**', async (route) => {
    const request = route.request();
    const local = request.url().replace('https://site.example', BASE);
    const answer = await context.request.fetch(local, {
      method: request.method(),
      headers: request.headers(),
      data: request.postData() || undefined,
      maxRedirects: 0
    });
    const headers = answer.headers();
    delete headers['content-encoding'];
    delete headers['content-length'];
    const type = headers['content-type'] || '';
    // The site knows itself by its WordPress address, which here is the local one: put this
    // site's address back so the page's own calls stay on it (a real site is served as itself).
    const body = /text|json|javascript/.test(type)
      ? (await answer.text()).split(BASE).join('https://site.example')
      : await answer.body();
    route.fulfill({ status: answer.status(), headers, body });
  });
}

for (const [name, engine] of ENGINES) {
  test(name + ': a guest page on another site frames the participant page and a question is asked', async (t) => {
    if (!(await siteUp())) { t.skip('wp-env is not running at ' + BASE); return; }
    const browser = await engine.launch();
    const sessionName = 'Guest page test ' + Date.now();
    let admin;
    try {
      admin = await adminFrame(browser);
      const session = await makeSession(admin, {
        name: sessionName, access: 'link', heading: 'Ask the panel',
        guestPage: { room: true, slide: true, panel: true, url: GUEST }
      });
      await callServer(admin, 'setSessionActive', [session.id, true]);

      // Every guest-facing link now goes through the guest page; the queue never does.
      assert.ok(session.links.participant.startsWith(GUEST), session.links.participant);
      assert.ok(session.links.present.startsWith(GUEST), session.links.present);
      assert.ok(session.links.slide.endsWith('&layout=qr'), session.links.slide);
      assert.ok(session.links.moderate.startsWith(BASE), session.links.moderate);
      // The link carries no site of its own: the hosted copy decides what it frames.
      assert.doesNotMatch(session.links.participant.split('?')[1], /https?:/);

      const guest = await browser.newContext();
      await hostGuestPage(guest);
      const page = await guest.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(session.links.participant);

      const framed = await (await page.waitForSelector('iframe[title="Question Desk"]')).contentFrame();
      await framed.waitForSelector('#q:not([disabled])');
      // The heading arrives with the session's state, a moment after the box is enabled.
      await framed.waitForFunction(() => document.getElementById('heading').textContent === 'Ask the panel');
      assert.equal(page.url().startsWith(GUEST), true, 'the address bar keeps the organization’s own link');

      await framed.fill('#q', 'Asked through the guest page, from the room');
      await framed.click('#send');
      await framed.waitForSelector('#sent:not([hidden])');
      assert.deepEqual(errors, []);

      const state = await callServer(admin, 'adminState', []);
      const after = state.value.sessions.filter((s) => s.id === session.id)[0];
      assert.equal(after.questionCount, 1, 'the question reached the session');
      await guest.close();
    } finally {
      if (admin) await removeSession(admin, sessionName);
      await browser.close();
    }
  });
}
