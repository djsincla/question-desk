'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, PUBLIC_URL } = require('./harness');

const MOD = 'mod@example.org';

test('a new session starts inactive with its own id and link key', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Family night' });
  assert.match(s.id, /^[a-f0-9]{8}$/);
  assert.match(s.linkKey, /^[a-f0-9]{16}$/);
  assert.equal(s.status, 'inactive');
  assert.equal(s.open, true);
  assert.equal(s.heading, 'Questions for the panel');
});

test('session fields are validated', () => {
  const h = createApp().install();
  assert.throws(() => h.app.saveSession({ name: '   ' }), /Give the session a name/);
  assert.throws(() => h.app.saveSession({ name: 'x', maxLength: 49 }), /between 50 and 1024/);
  assert.throws(() => h.app.saveSession({ name: 'x', maxLength: 1025 }), /between 50 and 1024/);
  const ok = h.session({ name: 'x'.repeat(200), maxLength: 1024, access: 'nonsense', theme: 'neon' });
  assert.equal(ok.name.length, 80);
  assert.equal(ok.maxLength, 1024);
  assert.equal(ok.access, 'room');
  assert.equal(ok.theme, 'dark');
});

test('only rostered moderators can be assigned to a session', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'x', moderators: [MOD, 'notonroster@example.org'] });
  assert.deepEqual(s.moderators, [MOD]);
});

test('editing a session keeps its id, status and link key', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Before', active: true });
  h.app.saveSession({ id: s.id, name: 'After', access: 'link', theme: 'light', maxLength: 500, moderators: [MOD], emailOnEnd: true });
  const after = h.app.getSession_(s.id);
  assert.equal(after.name, 'After');
  assert.equal(after.status, 'active');
  assert.equal(after.linkKey, s.linkKey);
  assert.equal(after.theme, 'light');
  assert.equal(after.emailOnEnd, true);
  assert.equal(h.app.allSessions_().length, 1);
});

test('activate, deactivate, end; an ended session cannot be reopened', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Lifecycle' });
  h.app.setSessionActive(s.id, true);
  assert.equal(h.app.getSession_(s.id).status, 'active');
  assert.ok(h.app.getSession_(s.id).started);
  h.app.setSessionActive(s.id, false);
  assert.equal(h.app.getSession_(s.id).status, 'inactive');
  h.app.setSessionActive(s.id, true);
  h.app.endSession(s.id, h.app.getSession_(s.id).name);
  const ended = h.app.getSession_(s.id);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.open, false);
  assert.throws(() => h.app.setSessionActive(s.id, true), /cannot be reopened/);
  assert.throws(() => h.app.endSession(s.id, h.app.getSession_(s.id).name), /already ended/);
});

test('several sessions can be active at once, each with its own room code', () => {
  const h = createApp().install();
  const a = h.session({ name: 'Room A', active: true });
  const b = h.session({ name: 'Room B', active: true });
  const urlA = h.app.getRoomScreen(a.id).url;
  const urlB = h.app.getRoomScreen(b.id).url;
  assert.notEqual(new URL(urlA).searchParams.get('t'), new URL(urlB).searchParams.get('t'));
  assert.equal(new URL(urlA).searchParams.get('s'), a.id);
});

test('links use the public /macros/s/ address, or the configured one', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Links', access: 'link' });
  const links = h.app.sessionLinks_(h.app.getSession_(s.id));
  assert.equal(links.present, PUBLIC_URL + '?view=present&s=' + s.id + '&r=' + h.app.getSession_(s.id).screenKey);
  assert.equal(links.moderate, PUBLIC_URL + '?view=moderate&s=' + s.id);
  assert.equal(links.participant, PUBLIC_URL + '?s=' + s.id + '&k=' + s.linkKey);

  h.app.saveBrand({ publicUrl: 'https://script.google.com/macros/s/OTHER_ID-1/exec' });
  assert.match(h.app.sessionLinks_(s).present, /^https:\/\/script\.google\.com\/macros\/s\/OTHER_ID-1\/exec\?/);
  assert.throws(() => h.app.saveBrand({ publicUrl: 'https://evil.example/exec' }), /looks like a guest page address/);
});

test('in-room sessions have no participant link', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Room only', access: 'room' });
  assert.equal(h.app.sessionLinks_(s).participant, null);
});

test('the room screen reports inactive sessions without a QR url', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Later' });
  const screen = h.app.getRoomScreen(s.id);
  assert.equal(screen.status, 'inactive');
  assert.equal(screen.url, null);
});

test('room screen follows theme changes made after it was opened', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Theme', theme: 'dark', active: true });
  assert.equal(h.app.getRoomScreen(s.id).theme, 'dark');
  h.app.saveSession({ id: s.id, name: 'Theme', theme: 'light' });
  assert.equal(h.app.getRoomScreen(s.id).theme, 'light');
});

test('unknown or malformed session ids are not found', () => {
  const h = createApp().install();
  assert.equal(h.app.getSession_('../../etc'), null);
  assert.equal(h.app.getSession_('deadbeef'), null);
  assert.throws(() => h.app.getBoard('deadbeef'), /Session not found/);
});

test('admins can reorder sessions, and every list follows that order', () => {
  const h = createApp().install({ moderators: [MOD] });
  const a = h.session({ name: 'A', moderators: [MOD], active: true });
  const b = h.session({ name: 'B', moderators: [MOD], active: true });
  const c = h.session({ name: 'C', moderators: [MOD], active: true });
  const names = () => h.app.adminState().sessions.map((s) => s.name);
  assert.deepEqual(names(), ['C', 'B', 'A'], 'newest first by default');

  h.app.reorderSessions([a.id, c.id, b.id]);
  assert.deepEqual(names(), ['A', 'C', 'B']);

  h.as(MOD);
  assert.deepEqual(h.app.mySessions().map((s) => s.name), ['A', 'C', 'B'], 'queue switcher');
  assert.deepEqual(h.app.doGet({ parameter: {} }).data.sessions.map((s) => s.name), ['A', 'C', 'B'], 'landing page');

  h.as(h.env.owner);
  h.session({ name: 'D' });
  assert.deepEqual(names(), ['D', 'A', 'C', 'B'], 'a new session goes on top');

  h.app.reorderSessions([b.id, 'ffffffff', b.id]);
  assert.deepEqual(names(), ['B', 'D', 'A', 'C'], 'unknown and duplicate ids ignored; the rest keep their order');
});

test('only admins reorder sessions', () => {
  const h = createApp().install({ moderators: [MOD] });
  const a = h.session({ name: 'A' });
  h.as(MOD);
  assert.throws(() => h.app.reorderSessions([a.id]), /Only administrators/);
  h.anonymous();
  assert.throws(() => h.app.reorderSessions([a.id]), /Only administrators/);
  h.as(h.env.owner);
  assert.throws(() => h.app.reorderSessions('nope'), /new order/);
});
