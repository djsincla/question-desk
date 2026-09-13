'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

function setup(prepared) {
  const h = createApp().install({ moderators: [MOD] });
  h.app.saveSession({ name: 'Prepared', access: 'link', moderators: [MOD], prepared });
  const s = h.app.allSessions_()[0];
  h.app.setSessionActive(s.id, true);
  return { h, s: h.app.getSession_(s.id) };
}

test('prepared questions load with the session and wait out of sight', () => {
  const { h, s } = setup('What is the plan for respite hours?\n\n  How do families   join the advisory board?  \n');
  assert.deepEqual(h.app.adminState().sessions[0].prepared,
    ['What is the plan for respite hours?', 'How do families join the advisory board?']);
  assert.equal(h.app.adminState().sessions[0].questionCount, 0, 'not counted as asked');

  h.as(MOD);
  const board = h.app.getBoard(s.id);
  assert.deepEqual(board.prepared.map((q) => q.text), ['What is the plan for respite hours?', 'How do families join the advisory board?']);
  assert.equal(board.unsorted.length + board.topics.length, 0, 'not in the queue');

  const calls = h.env.geminiCalls.length;
  assert.ok(h.env.geminiCalls.every((c) => !/Assign a topic/.test(c.prompt)), 'only translated when saved, never grouped');
  h.app.clusterAll_();
  assert.equal(h.env.geminiCalls.length, calls, 'not sent for grouping');
  const d = h.join(s);
  assert.deepEqual(h.anonymous().app.getTopics(s.id, d.deviceId).topics, [], 'not on phones');
});

test('a QA Facilitator adds prepared questions to the queue when needed', () => {
  const { h, s } = setup(['Parking for families with wheelchairs?', 'Funding for next year?']);
  h.as(MOD);
  const [first] = h.app.getBoard(s.id).prepared;
  h.advance(600);
  const board = h.app.usePrepared(s.id, [first.id]);
  assert.deepEqual(board.prepared.map((q) => q.text), ['Funding for next year?']);
  assert.deepEqual(board.unsorted.map((q) => q.text), ['Parking for families with wheelchairs?']);
  assert.equal(board.unsorted[0].submitted, h.env.clock.now, 'timestamped when added');

  h.app.clusterAll_();
  assert.deepEqual(h.app.getBoard(s.id).topics.map((t) => t.topic), ['About parking'], 'grouped like any question');
  assert.throws(() => h.app.usePrepared(s.id, [first.id]), /already added or removed/);
});

test('editing the list replaces unused prepared questions and keeps used ones', () => {
  const { h, s } = setup(['Used question one?', 'Unused question two?']);
  h.as(MOD);
  const used = h.app.getBoard(s.id).prepared[0];
  h.app.usePrepared(s.id, [used.id]);

  h.as(h.env.owner).app.saveSession({ id: s.id, name: 'Prepared', access: 'link', moderators: [MOD], prepared: 'Brand new question three?' });
  h.as(MOD);
  const board = h.app.getBoard(s.id);
  assert.deepEqual(board.prepared.map((q) => q.text), ['Brand new question three?']);
  assert.deepEqual(board.unsorted.map((q) => q.text), ['Used question one?']);

  h.as(h.env.owner).app.saveSession({ id: s.id, name: 'Prepared', access: 'link', moderators: [MOD] });
  assert.deepEqual(h.app.adminState().sessions[0].prepared, ['Brand new question three?'], 'omitting the field leaves the list alone');
});

test('prepared questions are validated and stored as text', () => {
  const h = createApp().install();
  assert.throws(() => h.app.saveSession({ name: 'x', prepared: 'ok question here\nhi' }), /too short: hi/);
  assert.throws(() => h.app.saveSession({ name: 'x', maxLength: 50, prepared: 'y'.repeat(51) }), /longer than 50/);
  assert.throws(() => h.app.saveSession({ name: 'x', prepared: Array.from({ length: 101 }, (_, i) => 'Question number ' + i) }), /at most 100/);
  h.app.saveSession({ name: 'Formula', prepared: '=IMPORTXML("http://x","//a") question' });
  assert.deepEqual(h.questions().formulas, []);
});

test('only assigned QA Facilitators add prepared questions, and not after the session ends', () => {
  const { h, s } = setup(['Prepared for later?']);
  const id = h.as(MOD).app.getBoard(s.id).prepared[0].id;
  h.as('other@example.org');
  assert.throws(() => h.app.usePrepared(s.id, [id]), /not a QA Facilitator/);
  h.anonymous();
  assert.throws(() => h.app.usePrepared(s.id, [id]), /not a QA Facilitator/);
  h.as(MOD);
  h.app.setStatus(s.id, [id], 'answered');
  assert.equal(h.app.getBoard(s.id).prepared.length, 1, 'setStatus cannot bypass usePrepared');
  h.as(h.env.owner).app.endSession(s.id, 'Prepared');
  h.as(MOD);
  assert.throws(() => h.app.usePrepared(s.id, [id]), /has ended/);
});

test('unused prepared questions stay out of the summary email', () => {
  const { h, s } = setup(['Never used question?', 'Used during the event?']);
  h.as(h.env.owner).app.saveSession({ id: s.id, name: 'Prepared', access: 'link', moderators: [MOD], emailOnEnd: true });
  h.as(MOD);
  h.app.usePrepared(s.id, [h.app.getBoard(s.id).prepared[1].id]);
  h.as(h.env.owner).app.endSession(s.id, 'Prepared');
  const mail = h.env.outbox[0];
  assert.match(mail.htmlBody, /Used during the event/);
  assert.doesNotMatch(mail.htmlBody, /Never used/);
  assert.doesNotMatch(mail.attachments[0].getDataAsString(), /Never used/);
});

test('prepared questions are translated into the session\'s languages when saved, if the session asks', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Community Day', languages: ['vi', 'zh'] }).savedEventId;
  h.app.saveSession({ name: 'Talk', access: 'link', moderators: [MOD], eventId: eid, prepared: ['Is there parking nearby?'] });
  const s = h.app.adminState().sessions[0];
  assert.equal(s.translatePrepared, true, 'on by default');
  const call = h.env.geminiCalls[h.env.geminiCalls.length - 1];
  assert.match(call.prompt, /translate it into Vietnamese and Chinese \(Simplified\)/);
  assert.doesNotMatch(call.prompt, /Korean|Spanish/, 'only the session\'s languages');

  h.as(MOD);
  const [prep] = h.app.getBoard(s.id).prepared;
  assert.equal(prep.lang, 'English');
  assert.deepEqual(prep.translations.map((t) => t.language), ['Vietnamese', 'Chinese (Simplified)']);

  // Adding a language to the event later translates the missing one on the next run.
  h.as(h.env.owner);
  h.app.saveEvent({ id: eid, name: 'Community Day', languages: ['vi', 'zh', 'ko'] });
  h.anonymous();
  h.app.clusterAll_();
  h.as(MOD);
  assert.deepEqual(h.app.getBoard(s.id).prepared[0].translations.map((t) => t.language), ['Vietnamese', 'Chinese (Simplified)', 'Korean']);
});

test('Answer now on a translated prepared question shows it in the session\'s languages', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Community Day', languages: ['vi'] }).savedEventId;
  h.app.saveSession({ name: 'Talk', access: 'link', moderators: [MOD], eventId: eid, prepared: ['Is there parking nearby?'] });
  const s = h.app.adminState().sessions[0];
  h.app.setSessionActive(s.id, true);
  h.as(MOD);
  const [prep] = h.app.getBoard(s.id).prepared;
  h.app.usePrepared(s.id, [prep.id]);
  h.app.setNowAnswering(s.id, null, prep.id);
  h.anonymous();
  const labels = h.app.getRoomScreen(s.id, 'full', h.screenKey(s)).nowAnswering.labels;
  assert.equal(labels.en, 'Is there parking nearby?');
  assert.equal(labels.vi, '[vi] Is there parking nearby?', 'Vietnamese from the saved translation');
});

test('with the option off nothing is translated at save; a Gemini outage at save is retried by the schedule', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.saveSession({ name: 'Off', access: 'link', moderators: [MOD], translatePrepared: false, prepared: ['Is there parking nearby?'] });
  assert.equal(h.env.geminiCalls.length, 0);
  assert.equal(h.app.adminState().sessions[0].translatePrepared, false);

  const normal = h.env.gemini;
  h.env.gemini = () => ({ status: 503, text: 'down' });
  h.app.saveSession({ name: 'On', access: 'link', moderators: [MOD], prepared: ['Where do families park?'] });
  const on = h.app.adminState().sessions.find((x) => x.name === 'On');
  h.as(MOD);
  assert.equal(h.app.getBoard(on.id).prepared[0].lang, '', 'not translated yet');
  h.env.gemini = normal;
  h.anonymous();
  h.app.clusterAll_();
  h.as(MOD);
  assert.equal(h.app.getBoard(on.id).prepared[0].lang, 'English', 'translated by the next run');
  const off = h.app.allSessions_().find((x) => x.name === 'Off');
  assert.equal(h.app.getBoard(off.id).prepared[0].lang, '', 'the session that said no stays untranslated');
});
