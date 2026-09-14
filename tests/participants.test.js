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
  h.app.endSession(s.id, h.app.getSession_(s.id).name);
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

test('room cap: 120 per minute per session, independent across sessions', () => {
  const h = createApp().install();
  assert.equal(h.app.CONFIG.roomLimitPerMinute, 120, 'room for a full room submitting at once');
  const a = h.session({ name: 'A', access: 'link', active: true });
  const b = h.session({ name: 'B', access: 'link', active: true });
  for (let i = 0; i < 120; i++) assert.equal(h.ask(a, h.join(a), 'Question number ' + i).ok, true);
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

test('each session sets its own wait between questions, validated', () => {
  const h = createApp().install();
  const quick = h.session({ name: 'Quick', access: 'link', active: true, cooldownSeconds: 60 });
  const none = h.session({ name: 'None', access: 'link', active: true, cooldownSeconds: 0 });
  const std = h.session({ name: 'Default', access: 'link', active: true });
  assert.equal(h.app.getSession_(std.id).cooldownSeconds, 300);

  const d = h.join(quick);
  assert.equal(h.ask(quick, d, 'First in quick session').cooldownSeconds, 60);
  h.advance(30);
  assert.equal(h.ask(quick, d, 'Too soon here').waitSeconds, 30);
  h.advance(31);
  assert.equal(h.ask(quick, d, 'Allowed after a minute').ok, true);

  const n = h.join(none);
  assert.equal(h.ask(none, n, 'No wait one').ok, true);
  assert.equal(h.ask(none, n, 'No wait two').ok, true);

  assert.throws(() => h.app.saveSession({ name: 'x', cooldownSeconds: -1 }), /between 0 and 3600/);
  assert.throws(() => h.app.saveSession({ name: 'x', cooldownSeconds: 3601 }), /between 0 and 3600/);
  assert.throws(() => h.app.saveSession({ name: 'x', cooldownSeconds: 'soon' }), /between 0 and 3600/);
});

test('changing the wait during a session applies immediately to phones already waiting', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Live change', access: 'link', active: true, cooldownSeconds: 300 });
  const d = h.join(s);
  assert.equal(h.ask(s, d, 'Asked before the change').ok, true);
  h.advance(60);
  assert.equal(h.anonymous().app.getSessionState(s.id, d.deviceId).cooldownRemaining, 240);

  h.as(h.env.owner).app.saveSession({ id: s.id, name: 'Live change', access: 'link', cooldownSeconds: 90 });
  assert.equal(h.anonymous().app.getSessionState(s.id, d.deviceId).cooldownRemaining, 30, 'shortened at once');
  assert.equal(h.ask(s, d, 'Still waiting a bit').waitSeconds, 30);

  h.as(h.env.owner).app.saveSession({ id: s.id, name: 'Live change', access: 'link', cooldownSeconds: 600 });
  assert.equal(h.anonymous().app.getSessionState(s.id, d.deviceId).cooldownRemaining, 540, 'lengthened at once');

  h.as(h.env.owner).app.saveSession({ id: s.id, name: 'Live change', access: 'link', cooldownSeconds: 0 });
  assert.equal(h.ask(s, d, 'Wait removed entirely').ok, true);
});

test('phones polling topics learn their remaining wait', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Poll', access: 'link', active: true, cooldownSeconds: 120 });
  const d = h.join(s);
  h.ask(s, d, 'A question to start the wait');
  h.advance(20);
  assert.equal(h.anonymous().app.getTopics(s.id, d.deviceId).cooldownRemaining, 100);
});

test('waits stored by 2.0 (as an end time) are still honored after upgrading', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Upgrade', access: 'link', active: true });
  const d = h.join(s);
  h.cache.put('cool:' + s.id + ':' + d.deviceId, String(h.env.clock.now + 200 * 1000), 300);
  assert.equal(h.anonymous().app.getSessionState(s.id, d.deviceId).cooldownRemaining, 200);
});

test('an old room code stays dead when the room screen comes back after a break', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Break', active: true });
  const r = h.screenKey(s);
  h.anonymous();
  const old = token(h.app.getRoomScreen(s.id, 'full', r).url);

  // Normal rotation: the code that was just on screen still works for one more window.
  h.advance(160);
  token(h.app.getRoomScreen(s.id, 'full', r).url);
  assert.equal(h.app.claimDevice(s.id, old).ok, true, 'a scan during rotation still works');

  // The screen is closed for hours; a photo of an old code must not work when it reopens.
  const photographed = token(h.app.getRoomScreen(s.id, 'full', r).url);
  h.advance(6 * 3600);
  token(h.app.getRoomScreen(s.id, 'full', r).url);
  assert.equal(h.app.claimDevice(s.id, photographed).ok, false);
});

test('questions are only ever written to the sheet while holding the script lock', () => {
  // Parallel appendRow calls overwrote each other in a 40-phone load test (2.14.1–2.15.0).
  const h = createApp().install();
  const s = h.session({ name: 'Lock', access: 'link', active: true, cooldownSeconds: 0 });
  for (let i = 0; i < 5; i++) h.ask(s, h.join(s), 'Question number ' + i + ' please');
  h.app.saveSession({ id: s.id, name: 'Lock', access: 'link', prepared: ['A prepared one'] });
  h.anonymous();
  h.app.doPost({ postData: { contents: JSON.stringify({ key: 'nope', text: 'x' }) } });
  assert.equal(h.questions().rows.length, 7, 'header, five questions and one prepared');
  assert.deepEqual(h.env.unlockedAppends, [], 'no question row written without the lock');
});

test('a burst of questions is saved to the inbox without the lock, then written to the sheet in one batch', () => {
  const h = createApp().install({ moderators: ['mod@example.org'] });
  const s = h.session({ name: 'Burst', access: 'link', active: true, moderators: ['mod@example.org'], cooldownSeconds: 0 });
  const d = h.join(s);
  h.env.lockDepth = 0;
  h.anonymous();
  const before = h.questionsRaw().rows.length;
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const res = h.app.submitQuestion(s.id, d.deviceId, 'Burst question number ' + i, d.credential);
    assert.equal(res.ok, true);
    ids.push(res.id);
  }
  assert.equal(h.questionsRaw().rows.length, before, 'nothing written to the sheet during the burst');
  assert.equal(h.inboxCount(s.id), 12);

  // The facilitator's next refresh brings them in, oldest first, in one write.
  h.as('mod@example.org');
  const board = h.app.getBoard(s.id);
  assert.equal(board.unsorted.length, 12);
  assert.deepEqual(h.questionsRaw().rows.slice(before).map((r) => r[0]), ids, 'in the order they were asked');
  assert.equal(h.inboxCount(s.id), 0);
  assert.deepEqual(h.env.unlockedAppends, []);

  // A flush interrupted after writing but before clearing its keys doesn't duplicate rows.
  h.anonymous();
  const again = h.app.submitQuestion(s.id, d.deviceId, 'One more question here', d.credential);
  const key = 'Q_' + s.id + '_' + again.id;
  const saved = h.props.getProperty(key);
  h.app.flushInbox_(s.id);
  h.props.setProperty(key, saved);
  h.app.flushInbox_(s.id);
  assert.equal(h.questionsRaw().rows.filter((r) => r[0] === again.id).length, 1);
});

test('questions sent just before a session ends are in its summary, and deleting a session clears its inbox', () => {
  const h = createApp().install({ moderators: ['mod@example.org'] });
  const s = h.session({ name: 'Ending', access: 'link', active: true, moderators: ['mod@example.org'], emailOnEnd: true, cooldownSeconds: 0 });
  h.ask(s, h.join(s), 'The very last question');
  assert.equal(h.inboxCount(s.id), 1);
  h.app.endSession(s.id, 'Ending');
  assert.match(h.env.outbox[0].attachments[0].getDataAsString(), /The very last question/);

  const t = h.session({ name: 'Doomed', access: 'link', active: true });
  h.ask(t, h.join(t), 'Never written anywhere');
  h.app.setSessionActive(t.id, false);
  h.app.deleteSession(t.id, 'Doomed');
  assert.equal(h.inboxCount(t.id), 0);
  assert.ok(!h.questionsRaw().rows.some((r) => r[3] === 'Never written anywhere'));
});
