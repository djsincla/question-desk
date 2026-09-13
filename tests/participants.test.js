'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const token = (url) => new URL(url).searchParams.get('t');

test('doGet hands the participant page its session and credential', () => {
  const h = createApp().install();
  const s = h.session({ name: 'x', active: true });
  h.anonymous();
  const page = h.app.doGet({ parameter: { s: s.id, t: 'abc123' } });
  assert.equal(page.file, 'Ask.html');
  assert.equal(page.data.sid, s.id);
  assert.equal(page.data.credential, 'abc123');

  const unknown = h.app.doGet({ parameter: { s: 'ffffffff', t: 'x' } });
  assert.equal(unknown.data.sid, '');
  const long = h.app.doGet({ parameter: { s: s.id, k: 'k'.repeat(500) } });
  assert.equal(long.data.credential.length, 64);
});

test('a room token joins once and a garbage token does not', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Room', active: true });
  const t = token(h.app.getRoomScreen(s.id).url);
  h.anonymous();
  assert.equal(h.app.claimDevice(s.id, 'wrong').reason, 'expired');
  assert.equal(h.app.claimDevice(s.id, '').reason, 'expired');
  const res = h.app.claimDevice(s.id, t);
  assert.equal(res.ok, true);
  assert.match(res.deviceId, /^[a-f0-9-]{36}$/);
  assert.equal(res.state.deviceValid, true);
});

test('room tokens rotate; the previous one survives one extra window', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Rotate', active: true });
  const first = token(h.app.getRoomScreen(s.id).url);

  h.advance(151);
  const second = token(h.app.getRoomScreen(s.id).url);
  assert.notEqual(first, second);

  h.anonymous();
  assert.equal(h.app.claimDevice(s.id, first).ok, true, 'previous token still valid right after rotation');
  h.advance(151);
  assert.equal(h.app.claimDevice(s.id, first).reason, 'expired', 'previous token dead after another window');
});

test('a forwarded room token dies even if no room screen is polling', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Nobody watching', active: true });
  const t = token(h.app.getRoomScreen(s.id).url);
  h.anonymous().advance(301);
  assert.equal(h.app.claimDevice(s.id, t).reason, 'expired');
});

test('credentials and device tokens do not cross sessions', () => {
  const h = createApp().install();
  const a = h.session({ name: 'A', active: true });
  const b = h.session({ name: 'B', active: true });
  const deviceA = h.join(a);

  h.anonymous();
  assert.equal(h.app.claimDevice(b.id, deviceA.credential).reason, 'expired');
  const res = h.app.submitQuestion(b.id, deviceA.deviceId, 'Can I ask in the other room?', '');
  assert.equal(res.reason, 'expired');
});

test('link sessions join with the key; replacing the link stops new joins only', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Link', access: 'link', active: true });
  const device = h.join(s);
  const oldKey = device.credential;

  h.app.regenerateLink(s.id);
  h.anonymous();
  assert.equal(h.app.claimDevice(s.id, oldKey).reason, 'expired');
  assert.equal(h.ask(s, { deviceId: device.deviceId, credential: oldKey }, 'Already joined, still works?').ok, true);
  const fresh = h.app.getSession_(s.id).linkKey;
  assert.equal(h.app.claimDevice(s.id, fresh).ok, true);
});

test('link keys never expire on their own', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Link', access: 'link', active: true });
  h.anonymous().advance(60 * 60 * 24 * 30);
  assert.equal(h.app.claimDevice(s.id, s.linkKey).ok, true);
});

test('submissions respect session status', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Status', active: true });
  const device = h.join(s);

  h.app.setSessionActive(s.id, false);
  assert.equal(h.ask(s, device, 'Is anyone there yet?').reason, 'inactive');

  h.app.setSessionActive(s.id, true);
  h.app.setBoardOpen(s.id, false);
  assert.equal(h.ask(s, device, 'Is this paused?').reason, 'closed');

  h.app.setBoardOpen(s.id, true);
  h.app.endSession(s.id);
  assert.equal(h.ask(s, device, 'Is this over?').reason, 'ended');
  h.anonymous();
  assert.equal(h.app.claimDevice(s.id, device.credential).reason, 'ended');
  assert.equal(h.app.submitQuestion('ffffffff', device.deviceId, 'Hello there', '').reason, 'notFound');
});

test('question length: too short, per-session max, and the 1024 ceiling', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Length', active: true, maxLength: 1024 });
  const short = h.session({ name: 'Short', active: true, maxLength: 100 });

  assert.equal(h.ask(s, h.join(s), 'hey').reason, 'tooShort');
  assert.equal(h.ask(s, h.join(s), '     a     ').reason, 'tooShort');
  assert.equal(h.ask(s, h.join(s), 'x'.repeat(1024)).ok, true);
  assert.equal(h.ask(s, h.join(s), 'x'.repeat(1025)).reason, 'tooLong');
  assert.equal(h.ask(short, h.join(short), 'x'.repeat(101)).reason, 'tooLong');
  assert.equal(h.ask(short, h.join(short), 'x'.repeat(100)).ok, true);
});

test('oversized and non-string payloads are rejected before any processing', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Flood', active: true });
  const device = h.join(s);
  const huge = 'x'.repeat(5 * 1024 * 1024);
  h.env.propertyReads = 0;
  assert.equal(h.ask(s, device, huge).reason, 'tooLong');
  assert.equal(h.env.propertyReads, 0, 'rejected before loading the session');
  assert.equal(h.ask(s, device, { toString: () => 'sneaky object payload' }).reason, 'tooLong');
  assert.equal(h.ask(s, device, ['array', 'payload']).reason, 'tooLong');
  assert.equal(h.questions().rows.length, 1, 'nothing was written');
});

test('whitespace is collapsed before the length check and storage', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Spaces', active: true, maxLength: 50 });
  const res = h.ask(s, h.join(s), '  What   about\n\n\n' + ' '.repeat(500) + 'parking?  ');
  assert.equal(res.ok, true);
  assert.equal(h.questions().rows[1][3], 'What about parking?');
});

test('cooldown reports real remaining seconds and lifts after 5 minutes', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Cooldown', active: true });
  const device = h.join(s);
  assert.equal(h.ask(s, device, 'First question here').ok, true);

  h.advance(100);
  const again = h.ask(s, device, 'Second question here');
  assert.equal(again.reason, 'cooldown');
  assert.equal(again.waitSeconds, 200);

  h.advance(201);
  assert.equal(h.ask(s, device, 'Third question here').ok, true);
});

test('cooldown is per session', () => {
  const h = createApp().install();
  const a = h.session({ name: 'A', access: 'link', active: true });
  const b = h.session({ name: 'B', access: 'link', active: true });
  const deviceA = h.join(a);
  assert.equal(h.ask(a, deviceA, 'Question for room A').ok, true);
  const deviceB = { deviceId: deviceA.deviceId, credential: b.linkKey };
  assert.equal(h.ask(b, deviceB, 'Question for room B').ok, true);
});

test('room cap: 15 per minute per session, independent across sessions', () => {
  const h = createApp().install();
  const a = h.session({ name: 'A', access: 'link', active: true });
  const b = h.session({ name: 'B', access: 'link', active: true });
  for (let i = 0; i < 15; i++) assert.equal(h.ask(a, h.join(a), 'Question number ' + i).ok, true);
  assert.equal(h.ask(a, h.join(a), 'One too many').reason, 'busy');
  assert.equal(h.ask(b, h.join(b), 'Other room is fine').ok, true);
  h.advance(60);
  assert.equal(h.ask(a, h.join(a), 'Next minute works').ok, true);
});

test('questions that look like formulas are stored as text', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Injection', access: 'link', active: true });
  const attacks = ['=IMPORTXML("http://x","//a")', '+1+cmd|calc', '-2+3 what', '@SUM(1,2) hello'];
  attacks.forEach((text) => assert.equal(h.ask(s, h.join(s), text).ok, true));
  assert.deepEqual(h.questions().formulas, []);
  assert.deepEqual(h.questions().rows.slice(1).map((r) => r[3]), attacks);
});

test('a malformed device id is never written to the sheet', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Device', access: 'link', active: true });
  h.anonymous();
  const res = h.app.submitQuestion(s.id, '=HYPERLINK("x")', 'Is my device id stored?', s.linkKey);
  assert.equal(res.ok, true);
  assert.equal(h.questions().rows[1][2], 'unknown');
});

test('a lapsed device token re-joins when the URL still carries a credential', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Long day', access: 'link', active: true });
  const device = h.join(s);
  h.advance(6 * 60 * 60 + 1);
  h.anonymous();
  const state = h.app.getSessionState(s.id, device.deviceId);
  assert.equal(state.deviceValid, false);
  assert.equal(h.ask(s, device, 'Still here after six hours').ok, true, 'link key still accepted');
});
