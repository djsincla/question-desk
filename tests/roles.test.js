'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, OWNER } = require('./harness');

const MOD = 'mod@example.org';
const ADMIN = 'admin2@example.org';

test('owner is always an administrator and gets the admin page', () => {
  const h = createApp().install();
  assert.equal(h.app.doGet({ parameter: { view: 'admin' } }).file, 'Admin.html');
  assert.equal(h.app.adminState().owner, OWNER);
});

test('anonymous visitors and non-admins are denied the admin page', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'admin' } }).file, 'Denied.html');
  h.as(MOD);
  assert.equal(h.app.doGet({ parameter: { view: 'admin' } }).file, 'Denied.html');
  assert.throws(() => h.app.adminState(), /Only administrators/);
});

test('added administrators can use admin functions', () => {
  const h = createApp().install({ admins: [ADMIN] });
  h.as(ADMIN);
  assert.equal(h.app.doGet({ parameter: { view: 'admin' } }).file, 'Admin.html');
  assert.doesNotThrow(() => h.app.saveSession({ name: 'By second admin' }));
});

test('people outside the Workspace domain cannot be added', () => {
  const h = createApp().install();
  assert.throws(() => h.app.addPerson('moderator', 'someone@gmail.test'), /Only @example\.org accounts/);
  assert.throws(() => h.app.addPerson('admin', 'someone@other-company.test'), /Only @example\.org/);
  assert.throws(() => h.app.addPerson('moderator', 'not-an-email'), /Not an email address/);
});

test('emails are normalized and not duplicated', () => {
  const h = createApp().install();
  h.app.addPerson('moderator', '  Mod@Example.org ');
  h.app.addPerson('moderator', 'mod@example.org');
  assert.deepEqual(h.app.adminState().moderators, [MOD]);
});

test('the owner and the current admin cannot be removed', () => {
  const h = createApp().install({ admins: [ADMIN] });
  assert.throws(() => h.app.removePerson('admin', OWNER), /always an administrator/);
  h.as(ADMIN);
  assert.throws(() => h.app.removePerson('admin', ADMIN), /cannot remove yourself/);
});

test('removing a moderator also unassigns them from every session', () => {
  const h = createApp().install({ moderators: [MOD, 'other@example.org'] });
  const a = h.session({ name: 'A', moderators: [MOD, 'other@example.org'] });
  const b = h.session({ name: 'B', moderators: [MOD] });
  h.app.removePerson('moderator', MOD);
  assert.deepEqual(h.app.getSession_(a.id).moderators, ['other@example.org']);
  assert.deepEqual(h.app.getSession_(b.id).moderators, []);
  h.as(MOD);
  assert.throws(() => h.app.getBoard(a.id), /not a QA Facilitator/);
});

test('moderators only reach sessions they are assigned to; admins reach all', () => {
  const h = createApp().install({ moderators: [MOD] });
  const mine = h.session({ name: 'Mine', moderators: [MOD] });
  const theirs = h.session({ name: 'Theirs', moderators: [] });

  h.as(MOD);
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: mine.id } }).file, 'Moderate.html');
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: theirs.id } }).file, 'Denied.html');
  assert.throws(() => h.app.getBoard(theirs.id), /not a QA Facilitator/);
  assert.deepEqual(h.app.mySessions().map((s) => s.name), ['Mine']);

  h.as(OWNER);
  assert.doesNotThrow(() => h.app.getBoard(theirs.id));
});

test('moderator views without a session show a picker of assigned, unended sessions', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.session({ name: 'Open one', moderators: [MOD], active: true });
  const done = h.session({ name: 'Finished', moderators: [MOD], active: true });
  h.session({ name: 'Not mine', moderators: [] });
  h.app.endSession(done.id, h.app.getSession_(done.id).name);

  h.as(MOD);
  const page = h.app.doGet({ parameter: { view: 'present' } });
  assert.equal(page.file, 'Denied.html');
  assert.deepEqual(page.data.links.map((l) => l.label), ['Open one']);
  assert.match(page.data.links[0].href, /\?view=present&s=[a-f0-9]{8}&r=[a-f0-9]{16}$/);
});

test('signed-in users not on any roster are denied moderator views', () => {
  const h = createApp().install();
  const s = h.session({ name: 'X' });
  h.as('stranger@example.org');
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: s.id } }).file, 'Denied.html');
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: s.id } }).file, 'Denied.html');
});

test('the room screen needs no sign-in, only its own link key', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Open screen', active: true, moderators: [MOD] });
  const r = h.screenKey(s);
  ['', 'someone@gmail.test', 'stranger@example.org', MOD, OWNER].forEach((who) => {
    h.env.activeUser = who;
    const page = h.app.doGet({ parameter: { view: 'present', s: s.id, r } });
    assert.equal(page.file, 'Present.html', 'as ' + (who || 'anonymous'));
    assert.match(h.app.getRoomScreen(s.id, 'full', r).url, /[?&]t=[a-f0-9]{12}/, 'as ' + (who || 'anonymous'));
  });

  // The session id is in every participant link and QR code, so it alone must not open the screen.
  ['', 'someone@gmail.test', 'stranger@example.org'].forEach((who) => {
    h.env.activeUser = who;
    [undefined, '', 'ffffffffffffffff'].forEach((bad) => {
      const page = h.app.doGet({ parameter: { view: 'present', s: s.id, r: bad } });
      assert.equal(page.data.heading, 'This room screen link is out of date', 'as ' + (who || 'anonymous'));
      assert.throws(() => h.app.getRoomScreen(s.id, 'full', bad), /out of date/);
    });
  });
  // Signed-in staff for the session don't need the key.
  h.as(MOD);
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id } }).file, 'Present.html');

  // Replacing the link retires the old key.
  h.as(OWNER);
  h.app.regenerateLink(s.id, 'screen');
  h.anonymous();
  assert.throws(() => h.app.getRoomScreen(s.id, 'full', r), /out of date/);
  assert.equal(h.app.getRoomScreen(s.id, 'full', h.screenKey(s)).status, 'active');
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: 'ffffffff' } }).data.heading, 'This room screen link is not valid');
  assert.throws(() => h.app.getRoomScreen('ffffffff'), /Session not found/);
});

test('queue and admin still require an authorized account', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Gated', active: true, moderators: [MOD] });
  ['', 'someone@gmail.test', 'stranger@example.org'].forEach((who) => {
    h.env.activeUser = who;
    assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: s.id } }).file, 'Denied.html');
    assert.equal(h.app.doGet({ parameter: { view: 'admin' } }).file, 'Denied.html');
    assert.throws(() => h.app.getBoard(s.id), /not a QA Facilitator/);
    assert.throws(() => h.app.setNowAnswering(s.id, 'x'), /not a QA Facilitator/);
  });
});

test('participant and room screen links use the public address; staff links stay as Google reports them', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Addresses', access: 'link', active: true });
  const room = h.session({ name: 'Room', access: 'room', active: true });
  const PUBLIC = 'https://script.google.com/macros/s/DEPLOYID/exec';
  [
    ['https://script.google.com/a/macros/example.org/s/DEPLOYID/exec', PUBLIC],
    ['https://script.google.com/a/example.org/macros/s/DEPLOYID/exec', 'https://script.google.com/a/example.org/macros/s/DEPLOYID/exec'],
    [PUBLIC, PUBLIC]
  ].forEach(([reported, staffBase]) => {
    h.env.deployUrl = reported;
    const links = h.app.sessionLinks_(h.app.getSession_(s.id));
    assert.equal(links.participant.split('?')[0], PUBLIC, 'participant link from ' + reported);
    assert.equal(h.app.getRoomScreen(room.id).url.split('?')[0], PUBLIC, 'QR code from ' + reported);
    assert.equal(links.present, PUBLIC + '?view=present&s=' + s.id + '&r=' + h.app.getSession_(s.id).screenKey, 'room screen link is public from ' + reported);
    assert.equal(links.moderate.split('?')[0], staffBase, 'queue link unchanged from ' + reported);
  });
});

test('the grouping trigger function runs only for its trigger or an administrator', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.setUp();
  const s = h.session({ name: 'Grouping', access: 'link', active: true, moderators: [MOD] });
  h.ask(s, h.join(s), 'Parking is a problem');
  h.env.geminiCalls.length = 0;

  // Every public function is callable from any page, so anonymous callers must be refused.
  h.anonymous();
  assert.throws(() => h.app.clusterQuestions(), /Not allowed/);
  assert.throws(() => h.app.clusterQuestions({ triggerUid: 'made-up' }), /Not allowed/);
  h.as(MOD);
  assert.throws(() => h.app.clusterQuestions(), /Not allowed/);
  assert.equal(h.env.geminiCalls.length, 0, 'no Gemini calls from refused callers');

  h.anonymous();
  assert.equal(h.app.clusterQuestions({ triggerUid: 'trigger-clusterQuestions' }), 1, 'the real trigger runs');
  h.as(OWNER);
  assert.doesNotThrow(() => h.app.clusterQuestions());
});

test('only guest pages can be framed by other sites', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Frames', access: 'link', active: true, moderators: [MOD] });
  const key = h.app.getSession_(s.id).linkKey;
  assert.equal(h.app.doGet({ parameter: { view: 'admin' } }).xframe, undefined, 'admin keeps Google\'s default');
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: s.id } }).xframe, undefined, 'queue keeps Google\'s default');
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { s: s.id, k: key } }).xframe, 'ALLOWALL', 'participant page');
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id } }).xframe, 'ALLOWALL', 'room screen');
});
