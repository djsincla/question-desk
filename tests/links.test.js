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
      const r = h.app.getSession_(s.id).screenKey;
      assert.match(r, /^[a-f0-9]{16}$/);
      assert.deepEqual(params(s.links.present), { view: 'present', s: s.id, r });
      isPublic(s.links.slide, s.name + ' PowerPoint slide');
      assert.deepEqual(params(s.links.slide), { view: 'present', s: s.id, r, layout: 'qr' });
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
  // Other languages' help lines come from the page's phrase list, one per event language.
  assert.match(present, /ko: \{[^}]*help: '[^']*시크릿[^']*'/);
  assert.match(present, /es: \{[^}]*help: '¿No se abre la página\? Prueba en una ventana privada\.'/);
  ['zh', 'vi', 'tl', 'hy'].forEach((code) => assert.match(present, new RegExp(code + ": \\{ scan: '[^']+', help: '[^']+', caption: '[^']+' \\}"), code));
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
  check(room.links.present, DIRECT + '?view=present&s=' + room.id + '&r=' + h.app.getSession_(room.id).screenKey, 'room screen');
  const roomQr = h.app.getRoomScreen(room.id).url;
  check(roomQr, DIRECT + '?s=' + room.id + '&t=' + new URL(roomQr).searchParams.get('t'), 'in-room QR code');

  const link = byName['Wrapped link'];
  const key = h.app.getSession_(link.id).linkKey;
  check(link.links.participant, DIRECT + '?s=' + link.id + '&k=' + key, 'questions link');
  check(h.app.getRoomScreen(link.id).url, DIRECT + '?s=' + link.id + '&k=' + key, 'link-session QR code');

  // Unchanged: the add-in slide link (the add-in already embeds from outside Google) and staff links.
  assert.equal(link.links.slide, DIRECT + '?view=present&s=' + link.id + '&r=' + h.app.getSession_(link.id).screenKey + '&layout=qr');
  assert.match(link.links.moderate, /^https:\/\/script\.google\.com\/a\/example\.org\/macros\/s\/.*\?view=moderate&s=/);
  assert.equal(RoomUrl.forSlide(room.links.present), DIRECT + '?view=present&s=' + room.id + '&r=' + h.app.getSession_(room.id).screenKey + '&layout=qr', 'add-in accepts a guest page room link');

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

});

test('guest page with no address anywhere uses the built-in GitHub Pages copy', () => {
  // Choosing "Guest page" and leaving the box blank must save, even if Branding is blank too.
  const bare = createApp().install();
  bare.app.saveSession({ name: 'No default', access: 'link', guestPage: { room: true, slide: true, url: '' } });
  const s = bare.app.adminState().sessions[0];
  assert.deepEqual(s.guestPage, { room: true, slide: true, url: '' });
  assert.equal(bare.app.adminState().guestPageDefault, 'https://djsincla.github.io/question-desk/join/');
  assert.ok(s.links.participant.startsWith('https://djsincla.github.io/question-desk/join/?d='), s.links.participant);

  // Setting Branding later changes the session's links without editing the session.
  bare.app.saveBrand({ guestPageUrl: 'https://autismla.example/questions/' });
  assert.ok(bare.app.adminState().sessions[0].links.participant.startsWith('https://autismla.example/questions/?d='));
});

test('clearing the organization guest page address falls back to the built-in copy', () => {
  const h = guestSetup();
  h.app.saveBrand({ guestPageUrl: '' });
  assert.equal(h.app.adminState().guestPageUrl, '');
});

test('the PowerPoint slide shows a QR code that goes through the guest page', () => {
  const h = guestSetup();
  h.app.saveSession({ name: 'Slide', access: 'room', guestPage: { mode: 'wrapper' } });
  const s = h.app.adminState().sessions[0];
  h.app.setSessionActive(s.id, true);
  const r = h.screenKey(s);
  h.anonymous();
  // The add-in shows the room screen in QR-only layout; that page asks getRoomScreen for its code.
  const slide = h.app.doGet({ parameter: { view: 'present', s: s.id, r, layout: 'qr' } });
  assert.equal(slide.data.layout, 'qr');
  assert.equal(slide.data.key, r, 'the page polls with its key');
  const qr = h.app.getRoomScreen(s.id, 'qr', r).url;
  assert.ok(qr.startsWith(GUEST + '?d=AKfycbTESTDEPLOYMENT_id-123456789&s=' + s.id + '&t='), qr);
  assert.ok(JoinUrl.target(new URL(qr).search), 'scanning it opens the questions page through the guest page');
});

test('room screen and PowerPoint slide each have their own guest page choice', () => {
  const h = guestSetup();
  const DIRECT = 'https://script.google.com/macros/s/AKfycbTESTDEPLOYMENT_id-123456789/exec';
  const make = (name, access, guestPage) => {
    h.app.saveSession({ name, access, guestPage });
    const s = h.app.adminState().sessions.find((x) => x.name === name);
    h.app.setSessionActive(s.id, true);
    return h.app.adminState().sessions.find((x) => x.name === name);
  };
  const viaGuest = (url) => url.startsWith(GUEST + '?d=');
  const viaDirect = (url) => url.startsWith(DIRECT + '?');

  const slideOnly = make('Slide only', 'room', { room: false, slide: true });
  assert.deepEqual(slideOnly.guestPage, { room: false, slide: true, url: '' });
  assert.ok(viaGuest(h.app.getRoomScreen(slideOnly.id, 'qr').url), 'slide QR uses the guest page');
  assert.ok(viaDirect(h.app.getRoomScreen(slideOnly.id).url), 'room screen QR stays direct');
  assert.ok(viaDirect(h.app.getRoomScreen(slideOnly.id, 'full').url), 'full layout is the room screen');
  assert.ok(viaDirect(slideOnly.links.present), 'room screen link stays direct');
  assert.ok(viaDirect(slideOnly.links.slide), 'the add-in always frames Question Desk directly');

  const roomOnly = make('Room only', 'link', { room: true, slide: false });
  assert.ok(viaGuest(h.app.getRoomScreen(roomOnly.id).url));
  assert.ok(viaDirect(h.app.getRoomScreen(roomOnly.id, 'qr').url));
  assert.ok(viaGuest(roomOnly.links.present));
  assert.ok(viaGuest(roomOnly.links.participant), 'shareable questions link: either choice turns it on');

  const neither = make('Neither', 'link', { room: false, slide: false, url: 'https://partner.example/ask/' });
  assert.deepEqual(neither.guestPage, { room: false, slide: false, url: '' }, 'no address kept when unused');
  assert.ok(viaDirect(neither.links.participant));
  assert.ok(viaDirect(h.app.getRoomScreen(neither.id, 'qr').url));
});

test('sessions saved before the split keep working: Guest page meant both, directly meant neither', () => {
  const h = guestSetup();
  h.app.saveSession({ name: 'Old wrapped', access: 'room' });
  h.app.saveSession({ name: 'Old direct', access: 'room' });
  const ids = Object.fromEntries(h.app.adminState().sessions.map((s) => [s.name, s.id]));
  // Write the old stored shape straight into the property, as 2.4.3 left it.
  const store = (id, guestPage) => {
    const raw = JSON.parse(h.props.getProperty('SESSION_' + id));
    raw.guestPage = guestPage;
    h.props.setProperty('SESSION_' + id, JSON.stringify(raw));
  };
  store(ids['Old wrapped'], { mode: 'wrapper', url: '' });
  store(ids['Old direct'], { mode: 'direct', url: '' });
  Object.values(ids).forEach((id) => h.app.setSessionActive(id, true));

  const byName = Object.fromEntries(h.app.adminState().sessions.map((s) => [s.name, s]));
  assert.deepEqual(byName['Old wrapped'].guestPage, { room: true, slide: true, url: '' });
  assert.deepEqual(byName['Old direct'].guestPage, { room: false, slide: false, url: '' });
  assert.ok(h.app.getRoomScreen(ids['Old wrapped']).url.startsWith(GUEST + '?d='));
  assert.ok(h.app.getRoomScreen(ids['Old wrapped'], 'qr').url.startsWith(GUEST + '?d='));
  assert.ok(!h.app.getRoomScreen(ids['Old direct'], 'qr').url.startsWith(GUEST));
});

test('the panelist view needs the room screen key and shows only what is being answered', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Panel', access: 'room', active: true, moderators: [MOD] });
  const r = h.screenKey(s);
  h.ask(s, h.join(s), 'Parking is a problem');
  h.app.clusterAll_();
  h.as(MOD);
  const topic = h.app.getBoard(s.id).topics[0].topic;
  h.app.setNowAnswering(s.id, topic);
  const board = h.app.getBoard(s.id);
  assert.ok(board.nowAnsweringSince > 0, 'the queue gets when answering started, for its timer');
  assert.equal(board.session.links.panel, 'https://script.google.com/macros/s/DEPLOYID/exec?view=panel&s=' + s.id + '&r=' + r);

  h.anonymous();
  const page = h.app.doGet({ parameter: { view: 'panel', s: s.id, r } });
  assert.equal(page.file, 'Panel.html');
  assert.equal(page.data.key, r);
  assert.equal(page.xframe, 'ALLOWALL', 'the guest page can frame it');
  assert.equal(h.app.doGet({ parameter: { view: 'panel', s: s.id } }).data.heading, 'This room screen link is out of date');
  const now = h.app.getRoomScreen(s.id, 'panel', r).nowAnswering;
  assert.equal(now.topic, topic);
  assert.equal(now.since, board.nowAnsweringSince);

  // Through the guest page too.
  assert.equal(JoinUrl.target('?d=AKfycb' + 'x'.repeat(30) + '&view=panel&s=' + s.id + '&r=' + r),
    'https://script.google.com/macros/s/AKfycb' + 'x'.repeat(30) + '/exec?view=panel&s=' + s.id + '&r=' + r);
});
