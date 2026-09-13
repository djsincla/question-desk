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
  assert.throws(() => h.app.getBoard(a.id), /not a moderator/);
});

test('moderators only reach sessions they are assigned to; admins reach all', () => {
  const h = createApp().install({ moderators: [MOD] });
  const mine = h.session({ name: 'Mine', moderators: [MOD] });
  const theirs = h.session({ name: 'Theirs', moderators: [] });

  h.as(MOD);
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: mine.id } }).file, 'Moderate.html');
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: theirs.id } }).file, 'Denied.html');
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: theirs.id } }).file, 'Denied.html');
  assert.throws(() => h.app.getBoard(theirs.id), /not a moderator/);
  assert.throws(() => h.app.getRoomScreen(theirs.id), /not a moderator/);
  assert.deepEqual(h.app.mySessions().map((s) => s.name), ['Mine']);

  h.as(OWNER);
  assert.doesNotThrow(() => h.app.getBoard(theirs.id));
});

test('moderator views without a session show a picker of assigned, unended sessions', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.session({ name: 'Open one', moderators: [MOD], active: true });
  const done = h.session({ name: 'Finished', moderators: [MOD], active: true });
  h.session({ name: 'Not mine', moderators: [] });
  h.app.endSession(done.id);

  h.as(MOD);
  const page = h.app.doGet({ parameter: { view: 'present' } });
  assert.equal(page.file, 'Denied.html');
  assert.deepEqual(page.data.links.map((l) => l.label), ['Open one']);
  assert.match(page.data.links[0].href, /\?view=present&s=[a-f0-9]{8}$/);
});

test('signed-in users not on any roster are denied moderator views', () => {
  const h = createApp().install();
  const s = h.session({ name: 'X' });
  h.as('stranger@example.org');
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: s.id } }).file, 'Denied.html');
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: s.id } }).file, 'Denied.html');
});
