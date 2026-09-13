'use strict';
/** Retention, the weekly report, settings storage, and backup grouping while Gemini is down. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, OWNER } = require('./harness');

const MOD = 'mod@example.org';
const DAY = 24 * 3600;

test('retention removes question wording from sessions that ended long ago, keeping topics and counts', () => {
  const h = createApp().install({ moderators: [MOD] });
  const old = h.session({ name: 'Old', access: 'link', active: true, moderators: [MOD] });
  const recent = h.session({ name: 'Recent', access: 'link', active: true, moderators: [MOD] });
  h.ask(old, h.join(old), 'Parking is a problem at the old venue');
  h.ask(recent, h.join(recent), 'Parking at the new venue');
  h.app.clusterAll_();
  h.as(MOD);
  const oldQ = h.app.getBoard(old.id).topics[0];
  h.app.mergeTopic(old.id, oldQ.topic);
  h.app.setStatus(old.id, [oldQ.questions[0].id], 'answered');
  h.as(OWNER);
  h.app.endSession(old.id, 'Old');
  h.advance(200 * DAY);
  h.app.endSession(recent.id, 'Recent');

  assert.equal(h.app.adminState().ops.retentionMonths, 0, 'kept by default');
  h.anonymous();
  h.app.clusterAll_();
  assert.match(h.questions().rows.find((r) => r[8] === old.id)[3], /old venue/, 'nothing removed while retention is off');

  h.as(OWNER);
  h.app.saveOpsSettings({ retentionMonths: 6, weeklyReport: false });
  h.anonymous();
  h.app.clusterAll_();
  const oldRow = h.questions().rows.find((r) => r[8] === old.id);
  assert.equal(oldRow[3], '[wording removed after 6 months]');
  assert.equal(oldRow[4], 'answered', 'status kept');
  assert.equal(oldRow[5], oldQ.topic, 'topic kept');
  assert.equal(h.app.topicRecords_(old.id)[oldQ.topic].merged, '[wording removed after 6 months]');
  assert.match(h.questions().rows.find((r) => r[8] === recent.id)[3], /new venue/, 'recent sessions untouched');
  h.as(OWNER);
  const entries = h.app.getActivity({ limit: 500 }).entries;
  assert.ok(entries.some((e) => e.who === 'Retention (automatic)' && /1 questions/.test(e.details)));
  assert.ok(entries.filter((e) => e.action === 'Marked answered').every((e) => /wording removed/.test(e.details)), 'quoted questions cleared from the log');

  // Runs hourly at most, and never twice over the same rows.
  h.anonymous();
  const before = JSON.stringify(h.questions().rows);
  h.advance(3600);
  h.app.clusterAll_();
  assert.equal(JSON.stringify(h.questions().rows), before);
  h.as(OWNER);
  assert.throws(() => h.app.saveOpsSettings({ retentionMonths: 5 }), /3, 6, 12 or 24/);
  h.as(MOD);
  assert.throws(() => h.app.saveOpsSettings({ retentionMonths: 3 }), /Only administrators/);
});

test('the weekly report goes to administrators on Monday mornings, once, and can be turned off', () => {
  const h = createApp().install({ admins: ['admin2@example.org'] });
  h.app.setUp();
  const soon = h.env.clock.now + 2 * DAY * 1000;
  h.app.saveSession({ name: 'Next week', scheduledStart: soon, scheduledEnd: soon + 3600000 });
  // The harness clock starts Saturday 2026-09-12, 11:00 in Los Angeles.
  h.anonymous();
  h.env.outbox.length = 0;
  h.app.clusterAll_();
  assert.equal(h.env.outbox.filter((m) => /weekly report/.test(m.subject)).length, 0, 'not on Saturday');

  h.advance(2 * DAY - 4 * 3600);   // Monday 07:00
  h.app.clusterAll_();
  assert.equal(h.env.outbox.filter((m) => /weekly report/.test(m.subject)).length, 0, 'not before 8 a.m.');
  h.advance(2 * 3600);             // Monday 09:00
  h.app.clusterAll_();
  const reports = h.env.outbox.filter((m) => /weekly report/.test(m.subject));
  assert.deepEqual(reports.map((m) => m.to), [OWNER, 'admin2@example.org']);
  assert.match(reports[0].htmlBody, /Next week/);
  assert.match(reports[0].htmlBody, /Settings storage/);
  h.advance(2 * 3600);
  h.app.clusterAll_();
  assert.equal(h.env.outbox.filter((m) => /weekly report/.test(m.subject)).length, 2, 'once a week');

  h.as(OWNER);
  h.app.saveOpsSettings({ retentionMonths: 0, weeklyReport: false });
  h.anonymous();
  h.advance(7 * DAY);
  h.app.clusterAll_();
  assert.equal(h.env.outbox.filter((m) => /weekly report/.test(m.subject)).length, 2, 'off means off');

  h.as(OWNER);
  h.app.sendWeeklyReportNow();
  assert.equal(h.env.outbox[h.env.outbox.length - 1].to, OWNER);
});

test('settings storage use is reported', () => {
  const h = createApp().install();
  const s = h.app.adminState().storage;
  assert.ok(s.bytes > 0 && s.limit === 500000 && s.percent >= 0);
  assert.ok(h.app.runHealthCheck().checks.some((c) => c.name === 'Settings storage' && c.ok));
});

test('while Gemini is down, the queue sorts ungrouped questions by a shared word and says so', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Outage', access: 'link', active: true, moderators: [MOD] });
  ['Is there parking near the venue?', 'Parking costs too much here', 'When does respite care start?',
   'Respite hours were cut again', 'Gracias por todo'].forEach((q) => h.ask(s, h.join(s), q));
  h.env.gemini = () => ({ status: 503, text: 'unavailable' });
  h.anonymous();
  h.app.clusterAll_();
  h.as(MOD);
  let board = h.app.getBoard(s.id);
  assert.equal(board.groupingDown, '', 'one failure is not an outage yet');
  h.anonymous();
  h.app.clusterAll_();
  h.as(MOD);
  board = h.app.getBoard(s.id);
  assert.match(board.groupingDown, /503/);
  const groups = Object.fromEntries(board.looseGroups.map((g) => [g.label, g.ids.length]));
  assert.equal(groups.parking, 2);
  assert.equal(groups.respite, 2);
  assert.equal(groups[''], 1, 'the rest under other questions');
  assert.equal(h.questions().rows.slice(1).filter((r) => r[5]).length, 0, 'nothing written: real grouping takes over later');
});

test('backup groups also appear when questions have waited a few minutes, even without failures', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Slow', access: 'link', active: true, moderators: [MOD] });
  h.ask(s, h.join(s), 'Parking near the hall');
  h.ask(s, h.join(s), 'Parking at night');
  h.as(MOD);
  assert.equal(h.app.getBoard(s.id).looseGroups, null, 'fresh questions: just wait for grouping');
  h.advance(4 * 60);
  assert.deepEqual(h.app.getBoard(s.id).looseGroups.map((g) => g.label), ['parking']);
});
