'use strict';
/**
 * Every link Question Desk hands out, checked for format. Guests and venue browsers are
 * signed into their own Google accounts, so anything a guest or a projector opens must use
 * the public /macros/s/<id>/exec address. Staff-only pages (queue, admin) may use the
 * address as Google reports it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';
const PUBLIC = 'https://script.google.com/macros/s/DEPLOYID/exec';
const REPORTED_FORMS = [
  'https://script.google.com/a/example.org/macros/s/DEPLOYID/exec',   // what Google reports for this project
  'https://script.google.com/a/macros/example.org/s/DEPLOYID/exec',
  PUBLIC
];

function params(url) {
  const u = new URL(url);
  return Object.fromEntries(u.searchParams.entries());
}

/** A well-formed link: https, no spaces, one '?', no /dev or /u/N account routing. */
function wellFormed(url, label) {
  assert.match(url, /^https:\/\/script\.google\.com\//, label + ': ' + url);
  assert.doesNotMatch(url, /\s/, label + ' has whitespace');
  assert.equal((url.match(/\?/g) || []).length, 1, label + ' has exactly one ?');
  assert.doesNotMatch(url, /\/dev(\?|$)|\/u\/\d+\//, label + ' must not be a /dev or /u/N address');
}

function isPublic(url, label) {
  wellFormed(url, label);
  assert.equal(url.split('?')[0], PUBLIC, label + ' uses the public address: ' + url);
}

function isStaff(url, label, reported) {
  wellFormed(url, label);
  assert.equal(url.split('?')[0], reported.replace('/a/macros/example.org/s/', '/macros/s/'), label + ': ' + url);
}

for (const reported of REPORTED_FORMS) {
  test('all links are correctly formed when Google reports ' + reported.replace('DEPLOYID/exec', '…'), () => {
    const h = createApp().install({ moderators: [MOD] });
    h.env.deployUrl = reported;
    const room = h.session({ name: 'Room session', access: 'room', active: true, moderators: [MOD] });
    const link = h.session({ name: 'Link session', access: 'link', active: true, moderators: [MOD] });

    // Admin page: Links panel.
    const sessions = Object.fromEntries(h.app.adminState().sessions.map((s) => [s.name, s]));
    for (const s of [sessions['Room session'], sessions['Link session']]) {
      isPublic(s.links.present, s.name + ' room screen');
      assert.deepEqual(params(s.links.present), { view: 'present', s: s.id });
      isPublic(s.links.slide, s.name + ' PowerPoint slide');
      assert.deepEqual(params(s.links.slide), { view: 'present', s: s.id, layout: 'qr' });
      isStaff(s.links.moderate, s.name + ' queue', reported);
      assert.deepEqual(params(s.links.moderate), { view: 'moderate', s: s.id });
    }
    assert.equal(sessions['Room session'].links.participant, null, 'in-room sessions have no participant link');
    isPublic(sessions['Link session'].links.participant, 'participant link');
    assert.deepEqual(params(sessions['Link session'].links.participant), { s: link.id, k: h.app.getSession_(link.id).linkKey });
    assert.match(params(sessions['Link session'].links.participant).k, /^[a-f0-9]{16}$/);

    // QR codes on the room screen.
    const roomQr = h.app.getRoomScreen(room.id).url;
    isPublic(roomQr, 'in-room QR');
    assert.equal(params(roomQr).s, room.id);
    assert.match(params(roomQr).t, /^[a-f0-9]{12}$/);
    assert.deepEqual(Object.keys(params(roomQr)).sort(), ['s', 't']);
    const linkQr = h.app.getRoomScreen(link.id).url;
    isPublic(linkQr, 'link-session QR');
    assert.equal(linkQr, sessions['Link session'].links.participant, 'the link session QR is its shareable link');

    // Emails.
    h.app.emailLinks(link.id, { to: 'guest@example.org', participant: true, present: true, moderate: true });
    const hrefs = Array.from(h.env.outbox[0].htmlBody.matchAll(/href="([^"]+)"/g), (m) => m[1].replace(/&amp;/g, '&'));
    assert.equal(hrefs.length, 3);
    isPublic(hrefs[0], 'emailed participant link');
    isPublic(hrefs[1], 'emailed room screen link');
    isStaff(hrefs[2], 'emailed queue link', reported);

    // Queue page header links, landing page, session picker.
    h.as(MOD);
    const board = h.app.getBoard(room.id);
    isPublic(board.session.links.present, 'queue page "Room screen" link');
    isStaff(board.adminUrl, 'queue page "Admin" link', reported);
    const home = h.app.doGet({ parameter: {} }).data;
    home.sessions.forEach((s) => { isPublic(s.present, 'landing page room screen'); isStaff(s.moderate, 'landing page queue', reported); });
    h.app.doGet({ parameter: { view: 'present' } });   // public room screen needs a session; no picker
    const picker = h.app.doGet({ parameter: { view: 'moderate' } }).data.links;
    picker.forEach((l) => isStaff(l.href, 'queue picker', reported));

    // Load test command.
    h.as(h.env.owner);
    const cmd = h.app.startLoadTest().loadTest.command;
    assert.match(cmd, new RegExp('--url "' + PUBLIC.replace(/[.\/]/g, '\\$&') + '"'));
  });
}

test('an admin-set app address in the domain form still gives public guest links', () => {
  const h = createApp().install();
  const link = h.session({ name: 'Link', access: 'link', active: true });
  h.app.saveBrand({ publicUrl: 'https://script.google.com/macros/s/OTHER-ID_9/exec' });
  const s = h.app.adminState().sessions[0];
  assert.equal(s.links.participant.split('?')[0], 'https://script.google.com/macros/s/OTHER-ID_9/exec');
  assert.equal(s.links.present.split('?')[0], 'https://script.google.com/macros/s/OTHER-ID_9/exec');
  assert.throws(() => h.app.saveBrand({ publicUrl: 'https://script.google.com/a/example.org/macros/s/X/exec' }), /must look like/,
    'the app address setting only accepts the public form');
  assert.ok(link);
});

test('guests are told what to do if Google refuses to open a page', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const present = fs.readFileSync(path.join(__dirname, '..', 'Present.html'), 'utf8');
  assert.match(present, /<span lang="en">Page won’t open\? Try a private browsing window\.<\/span>/);
  assert.match(present, /<span lang="ko">[^<]*시크릿[^<]*<\/span>/);
  assert.match(present, /<span lang="es">¿No se abre la página\? Prueba en una ventana privada\.<\/span>/);
  assert.match(present, /class="caption"[^>]*>[\s\S]*?<small class="help">Page won’t open\?/, 'slide caption too');

  const h = createApp().install();
  const s = h.session({ name: 'Help', access: 'link' });
  h.app.emailLinks(s.id, { to: 'guest@example.org', participant: true, present: true });
  assert.match(h.env.outbox[0].htmlBody, /Sorry, unable to open the file&quot;, open it in a private browsing window/);
  assert.match(h.env.outbox[0].htmlBody, /Use a private browsing window on the projector computer/);
});

// ------------------------------------------------------------ guest page (docs/join)

const JoinUrl = require('../docs/join/join-url');
const RoomUrl = require('../docs/addin/room-url');
const GUEST = 'https://autismla.example/questions/';

function guestSetup() {
  const h = createApp().install({ moderators: [MOD] });
  h.env.deployUrl = 'https://script.google.com/a/example.org/macros/s/AKfycbTESTDEPLOYMENT_id-123456789/exec';
  h.app.saveBrand({ guestPageUrl: 'https://autismla.example/questions' });
  return h;
}

test('sessions that use the guest page hand out guest page links the wrapper understands', () => {
  const h = guestSetup();
  const DIRECT = 'https://script.google.com/macros/s/AKfycbTESTDEPLOYMENT_id-123456789/exec';
  h.app.saveSession({ name: 'Wrapped room', access: 'room', moderators: [MOD], guestPage: { mode: 'wrapper' } });
  h.app.saveSession({ name: 'Wrapped link', access: 'link', moderators: [MOD], guestPage: { mode: 'wrapper' } });
  h.app.saveSession({ name: 'Direct', access: 'link', moderators: [MOD], guestPage: { mode: 'direct' } });
  const byName = Object.fromEntries(h.app.adminState().sessions.map((s) => [s.name, s]));
  Object.values(byName).forEach((s) => h.app.setSessionActive(s.id, true));
  assert.equal(h.app.adminState().guestPageUrl, GUEST, 'folder address gets a trailing slash');

  const check = (url, expectedDirect, label) => {
    assert.ok(url.startsWith(GUEST + '?d=AKfycbTESTDEPLOYMENT_id-123456789&'), label + ': ' + url);
    const u = new URL(url);
    assert.equal(JoinUrl.target(u.search), expectedDirect, label + ' opens the right Question Desk page');
  };

  const room = byName['Wrapped room'];
  check(room.links.present, DIRECT + '?view=present&s=' + room.id, 'room screen');
  const roomQr = h.app.getRoomScreen(room.id).url;
  check(roomQr, DIRECT + '?s=' + room.id + '&t=' + new URL(roomQr).searchParams.get('t'), 'in-room QR code');

  const link = byName['Wrapped link'];
  const key = h.app.getSession_(link.id).linkKey;
  check(link.links.participant, DIRECT + '?s=' + link.id + '&k=' + key, 'questions link');
  check(h.app.getRoomScreen(link.id).url, DIRECT + '?s=' + link.id + '&k=' + key, 'link-session QR code');

  // Unchanged: the add-in slide link (the add-in already embeds from outside Google) and staff links.
  assert.equal(link.links.slide, DIRECT + '?view=present&s=' + link.id + '&layout=qr');
  assert.match(link.links.moderate, /^https:\/\/script\.google\.com\/a\/example\.org\/macros\/s\/.*\?view=moderate&s=/);
  assert.equal(RoomUrl.forSlide(room.links.present), DIRECT + '?view=present&s=' + room.id + '&layout=qr', 'add-in accepts a guest page room link');

  // Emails use the guest page too.
  h.app.emailLinks(link.id, { to: 'guest@example.org', participant: true, present: true });
  const hrefs = Array.from(h.env.outbox[0].htmlBody.matchAll(/href="([^"]+)"/g), (m) => m[1].replace(/&amp;/g, '&'));
  hrefs.forEach((href) => assert.ok(href.startsWith(GUEST + '?d='), 'emailed ' + href));

  // A direct session is untouched.
  assert.equal(byName.Direct.links.participant.split('?')[0], DIRECT);
});

test('a session can use its own guest page address, and the choice is validated', () => {
  const h = guestSetup();
  h.app.saveSession({ name: 'Partner', access: 'link', guestPage: { mode: 'wrapper', url: 'https://partner.example/ask/index.html' } });
  const s = h.app.adminState().sessions[0];
  assert.ok(s.links.participant.startsWith('https://partner.example/ask/index.html?d='));

  h.app.saveSession({ id: s.id, name: 'Partner renamed', access: 'link' });
  assert.ok(h.app.adminState().sessions[0].links.participant.startsWith('https://partner.example/ask/index.html?d='), 'kept when not sent');

  ['http://partner.example/', 'https://partner.example/?x=1', 'https://partner.example/#x', 'javascript:alert(1)', 'ftp://x.example/']
    .forEach((url) => assert.throws(() => h.app.saveSession({ name: 'Bad', guestPage: { mode: 'wrapper', url } }), /guest page address must be an https/, url));
  assert.throws(() => h.app.saveBrand({ guestPageUrl: 'http://autismla.example/q' }), /guest page address must be an https/);

  const bare = createApp().install();
  assert.throws(() => bare.app.saveSession({ name: 'No default', guestPage: { mode: 'wrapper' } }), /Set a guest page address/);
});

test('clearing the organization guest page address turns it off', () => {
  const h = guestSetup();
  h.app.saveBrand({ guestPageUrl: '' });
  assert.equal(h.app.adminState().guestPageUrl, '');
});
