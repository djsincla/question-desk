'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

test('a fresh install creates both sheets and one clustering trigger', () => {
  const h = createApp();
  h.app.setUp();
  h.app.setUp();
  assert.deepEqual(h.questions().rows[0], h.app.HEADERS);
  assert.deepEqual(h.topics().rows[0], h.app.TOPIC_HEADERS);
  assert.ok(h.assets(), 'Assets sheet for logos');
  assert.equal(h.env.triggers.length, 1);
  assert.equal(h.env.triggers[0].getHandlerFunction(), 'clusterQuestions');
  assert.equal(h.app.allSessions_().length, 0, 'no sessions invented on a fresh install');
});

test('setUp migrates a single-session (v3) install into "First session"', () => {
  const h = createApp();
  const sheet = h.legacySheet([
    ['q1', new Date(), 'dev', 'Old question one', 'new', 'Parking', 'English', 'Old question one'],
    ['q2', new Date(), 'dev', 'Old question two', 'answered', '', '', '']
  ]);
  h.props.setProperty('MODERATORS', 'mod@example.org');
  h.props.setProperty('TOKEN_CURRENT', 'oldtoken');
  h.props.setProperty('TOKEN_PREVIOUS', 'older');
  h.props.setProperty('TOKEN_ISSUED', '1');
  h.props.setProperty('BOARD_OPEN', 'false');
  h.props.setProperty('SESSION_HEADING', 'Town hall');
  h.props.setProperty('MERGED', JSON.stringify({ Parking: 'What about parking?' }));

  h.app.setUp();

  const sessions = h.app.allSessions_();
  assert.equal(sessions.length, 1);
  const first = sessions[0];
  assert.equal(first.name, 'First session');
  assert.equal(first.heading, 'Town hall');
  assert.equal(first.status, 'active');
  assert.equal(first.open, false);
  assert.deepEqual(first.moderators, ['mod@example.org']);

  assert.equal(sheet.rows[0][8], 'Session');
  assert.deepEqual(sheet.rows.slice(1).map((r) => r[8]), [first.id, first.id]);
  assert.equal(h.app.topicRecords_(first.id).Parking.merged, 'What about parking?');
  ['TOKEN_CURRENT', 'TOKEN_PREVIOUS', 'TOKEN_ISSUED', 'BOARD_OPEN', 'MERGED', 'SESSION_HEADING']
    .forEach((k) => assert.equal(h.props.getProperty(k), null, k + ' removed'));

  h.app.setUp();
  assert.equal(h.app.allSessions_().length, 1, 're-running setUp does not migrate twice');

  // The migrated session works end to end once reopened (it kept the paused state).
  const device = h.join(first);
  assert.equal(h.ask(first, device, 'Asked while still paused').reason, 'closed');
  h.app.setBoardOpen(first.id, true);
  assert.equal(h.ask(first, device, 'New question after migration').ok, true);
  assert.equal(h.app.getBoard(first.id).topics.length + h.app.getBoard(first.id).unsorted.length, 3);
});

test('setUp asks for the email permission by touching MailApp', () => {
  const h = createApp();
  h.app.setUp();
  assert.ok(h.env.logs.some((l) => /Email quota remaining today/.test(l)));
});
