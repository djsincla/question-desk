'use strict';
/** The activity log: who did what, when — staff actions and the schedule, never participants. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, OWNER } = require('./harness');

const MOD = 'mod@example.org';

function log(h) {
  const was = h.env.activeUser;
  h.env.activeUser = OWNER;
  const out = h.app.getActivity({ limit: 500 }).entries.slice().reverse();   // oldest first
  h.env.activeUser = was;
  return out;
}

test('admin and QA Facilitator actions are logged with who, what and the session', () => {
  const h = createApp().install({ moderators: [MOD] });
  const setup = log(h).length;   // installing adds the test's QA Facilitator
  const eid = h.app.saveEvent({ name: 'Fall Conference' }).savedEventId;
  h.app.saveSession({ name: 'Keynote', access: 'link', moderators: [MOD], eventId: eid });
  const s = h.app.adminState().sessions[0];
  h.app.saveSession({ id: s.id, name: 'Keynote Q&A', access: 'link', moderators: [MOD], eventId: eid, theme: 'light' });
  h.app.setSessionActive(s.id, true);
  h.app.regenerateLink(s.id, 'screen');

  const d = h.join(h.app.getSession_(s.id));
  h.anonymous();
  h.app.submitQuestion(s.id, d.deviceId, 'Is there parking nearby?', d.credential);
  h.app.clusterAll_();

  h.as(MOD);
  const board = h.app.getBoard(s.id);
  const topic = board.topics[0].topic;
  h.app.setTopicShown(s.id, topic, true);
  h.app.setNowAnswering(s.id, topic);
  h.app.setStatus(s.id, [board.topics[0].questions[0].id], 'answered');
  h.app.setBoardOpen(s.id, false);

  h.as(OWNER);
  h.app.addPerson('moderator', 'new@example.org');
  h.app.endSession(s.id, 'Keynote Q&A');

  const entries = log(h).slice(setup);
  const rows = entries.map((e) => [e.who, e.action]);
  assert.deepEqual(rows, [
    [OWNER, 'Event created'],
    [OWNER, 'Session created'],
    [OWNER, 'Session edited'],
    [OWNER, 'Session activated'],
    [OWNER, 'Room screen link replaced'],
    [MOD, 'Topic shown on phones'],
    [MOD, 'Answer now'],
    [MOD, 'Marked answered'],
    [MOD, 'Questions paused'],
    [OWNER, 'QA Facilitator added'],
    [OWNER, 'Session ended']
  ]);
  const edited = entries[2];
  assert.equal(edited.label, 'Fall Conference — Keynote Q&A');
  assert.equal(edited.target, s.id);
  assert.match(edited.details, /renamed from "Keynote"/);
  assert.match(edited.details, /theme/);
  assert.equal(entries[7].details, '"Is there parking nearby?"');
  assert.equal(entries[0].label, 'Fall Conference');
  assert.ok(!entries.some((e) => /submit|question asked/i.test(e.action)), 'participants are not logged');
});

test('what the schedule does on its own is logged as the schedule', () => {
  const h = createApp().install();
  const start = h.env.clock.now + 60 * 1000;
  const s = h.session({ name: 'Timed', scheduledStart: start, scheduledEnd: start + 3600 * 1000 });
  h.advance(120).anonymous();
  h.app.clusterAll_();
  h.advance(3600);
  h.app.clusterAll_();
  const auto = log(h).filter((e) => e.who === 'Schedule (automatic)').map((e) => e.action);
  assert.deepEqual(auto, ['Session started', 'Session ended']);
  assert.equal(log(h).filter((e) => e.target === s.id).length, 3, 'created, started, ended');
});

test('CSV imports are logged per session and as a whole; the log is searchable and admin-only', () => {
  const h = createApp().install({ moderators: [MOD] });
  const setup = log(h).length;
  h.app.importSessionsCsv('Event,Session\nSpring,One\nSpring,Two', {}, false);
  const entries = log(h).slice(setup);
  assert.deepEqual(entries.map((e) => e.action), ['Event created', 'Session created', 'Session created', 'Sessions imported']);
  assert.match(entries[1].details, /\(CSV import\)/);
  assert.match(entries[3].details, /^2 created/);

  assert.equal(h.app.getActivity({ query: 'two' }).entries.length, 1);
  const oneId = h.app.adminState().sessions.find((x) => x.name === 'One').id;
  assert.deepEqual(h.app.getActivity({ target: oneId }).entries.map((e) => e.action), ['Session created']);
  h.as(MOD);
  assert.throws(() => h.app.getActivity({}), /Only administrators/);
});

test('log text that looks like a formula is stored as text, and old entries are trimmed', () => {
  const h = createApp().install();
  h.app.saveSession({ name: '=HYPERLINK("http://evil.example")' });
  assert.ok(h.app.flushAudit_() >= 1, 'entries written');
  const sheet = h.spreadsheet().getSheetByName('Activity log');
  assert.ok(sheet.rows.some((r) => String(r[4]).indexOf('HYPERLINK') !== -1), 'the entry is there');
  assert.deepEqual(sheet.formulas, []);

  for (let i = 0; i < 30; i++) sheet.appendRow([new Date(), 'x', 'Filler', '', '', '']);
  h.app.CONFIG.auditMaxRows = 20;
  h.anonymous();
  h.app.clusterAll_();
  assert.ok(sheet.rows.length - 1 <= 20, 'trimmed to the limit, rows: ' + (sheet.rows.length - 1));
  assert.equal(sheet.rows[0][0], 'Time', 'header kept');
});

test('a logging failure never blocks the action, and buffered entries wait for the sheet', () => {
  const h = createApp().install();
  // Both the buffer and the direct fallback refuse.
  const realSet = h.props.setProperty;
  h.props.setProperty = function (k, v) { if (String(k).indexOf('A_') === 0) throw new Error('Storage is full'); return realSet.call(this, k, v); };
  const sheet = h.app.auditSheet_();
  const realSetValues = sheet.getRange;
  sheet.getRange = function () { throw new Error('Sheets is down'); };
  assert.doesNotThrow(() => h.app.saveSession({ name: 'Still saves' }));
  sheet.getRange = realSetValues;
  h.props.setProperty = realSet;
  assert.equal(h.app.adminState().sessions[0].name, 'Still saves');
  assert.ok(h.env.logs.some((l) => /Activity log: Error: Sheets is down/.test(l)));

  // Normally entries sit in the buffer until a flush writes them all at once.
  const rowsBefore = sheet.rows.length;
  h.app.saveSession({ name: 'Buffered one' });
  h.app.saveSession({ name: 'Buffered two' });
  assert.equal(sheet.rows.length, rowsBefore, 'not written yet');
  assert.equal(h.app.flushAudit_(), 2);
  assert.deepEqual(sheet.rows.slice(rowsBefore).map((r) => r[2]), ['Session created', 'Session created']);
  assert.equal(h.app.flushAudit_(), 0, 'buffer cleared');
});
