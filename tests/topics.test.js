'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

function setup() {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Topics', access: 'link', active: true, moderators: [MOD] });
  return { h, s };
}

test('participants see translated topic labels, never question text', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is impossible, the lot is a disaster');
  h.app.clusterQuestions();

  const me = h.join(s);
  h.anonymous();
  const res = h.app.getTopics(s.id, me.deviceId);
  assert.equal(res.ok, true);
  assert.equal(res.topics.length, 1);
  assert.deepEqual(res.topics[0].labels, { en: 'About parking', ko: '[ko] About parking', es: '[es] About parking' });
  assert.equal(res.topics[0].count, 1);
  assert.doesNotMatch(JSON.stringify(res), /disaster/, 'no question text leaks to participants');
});

test('ungrouped, dismissed-only and other-session topics are not shown', () => {
  const { h, s } = setup();
  const other = h.session({ name: 'Other', access: 'link', active: true });
  h.ask(s, h.join(s), 'Parking is hard');
  h.ask(s, h.join(s), 'Spam spam spam');
  h.ask(other, h.join(other), 'Funding question');
  h.app.clusterQuestions();
  h.ask(s, h.join(s), 'Not grouped yet');
  h.app.setStatus(s.id, [h.questions().rows[2][0]], 'dismissed');

  const me = h.join(s);
  h.advance(16);
  const topics = h.anonymous().app.getTopics(s.id, me.deviceId).topics.map((t) => t.topic);
  assert.deepEqual(topics, ['About parking']);
});

test('topics require a joined device', () => {
  const { h, s } = setup();
  h.anonymous();
  assert.equal(h.app.getTopics(s.id, '').reason, 'expired');
  assert.equal(h.app.getTopics(s.id, '00000000-0000-0000-0000-000000000000').reason, 'expired');
  assert.equal(h.app.getTopics('ffffffff', '').reason, 'notFound');
  const other = h.session({ name: 'Other', access: 'link', active: true });
  const device = h.join(other);
  assert.equal(h.anonymous().app.getTopics(s.id, device.deviceId).reason, 'expired', 'device from another session');
});

test('me too toggles once per device and counts toward the topic', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is hard');
  h.app.clusterQuestions();
  const a = h.join(s);
  const b = h.join(s);
  h.anonymous();

  assert.deepEqual(h.app.meToo(s.id, a.deviceId, 'About parking'), { ok: true, mine: true, votes: 1 });
  assert.deepEqual(h.app.meToo(s.id, b.deviceId, 'About parking'), { ok: true, mine: true, votes: 2 });
  let topic = h.app.getTopics(s.id, a.deviceId).topics[0];
  assert.equal(topic.count, 3, '1 question + 2 me too');
  assert.equal(topic.mine, true);

  assert.deepEqual(h.app.meToo(s.id, a.deviceId, 'About parking'), { ok: true, mine: false, votes: 1 });
  topic = h.app.getTopics(s.id, a.deviceId).topics[0];
  assert.equal(topic.count, 2);
  assert.equal(topic.mine, false);

  h.as(MOD);
  assert.equal(h.app.getBoard(s.id).topics[0].votes, 1);
});

test('me too is refused for unknown topics, closed, inactive and ended sessions', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is hard');
  h.app.clusterQuestions();
  const d = h.join(s);
  h.anonymous();
  assert.equal(h.app.meToo(s.id, d.deviceId, 'Invented topic').reason, 'unknownTopic');
  assert.equal(h.app.meToo(s.id, '', 'About parking').reason, 'expired');

  h.as(MOD).app.setBoardOpen(s.id, false);
  assert.equal(h.anonymous().app.meToo(s.id, d.deviceId, 'About parking').reason, 'closed');
  h.as(MOD).app.setBoardOpen(s.id, true);
  h.as(h.env.owner).app.setSessionActive(s.id, false);
  assert.equal(h.anonymous().app.meToo(s.id, d.deviceId, 'About parking').reason, 'inactive');
  h.as(h.env.owner).app.endSession(s.id);
  assert.equal(h.anonymous().app.meToo(s.id, d.deviceId, 'About parking').reason, 'ended');
});

test('a full room polling topics hits the sheet once per cache window', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is hard');
  h.app.clusterQuestions();
  const devices = Array.from({ length: 40 }, () => h.join(s));
  h.anonymous();

  let reads = 0;
  const sheet = h.questions();
  const original = sheet.getDataRange;
  sheet.getDataRange = function () { reads++; return original.call(sheet); };

  h.advance(16);
  devices.forEach((d) => assert.equal(h.app.getTopics(s.id, d.deviceId).ok, true));
  assert.equal(reads, 1, '40 polls, one sheet read');
  h.advance(16);
  h.app.getTopics(s.id, devices[0].deviceId);
  assert.equal(reads, 2, 'refreshed after the cache window');
});

test('topic label translations are kept stable across grouping runs', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is hard');
  h.app.clusterQuestions();
  h.env.gemini = (call) => {
    const id = call.prompt.match(/\n([a-f0-9]{8}): /)[1];
    return { assignments: [{ id, topic: 'About parking', language: 'English', translation: 'x' }],
             labels: [{ topic: 'About parking', translations: { ko: 'DIFFERENT', es: 'DIFFERENT' } }] };
  };
  h.ask(s, h.join(s), 'Parking again');
  h.app.clusterQuestions();
  assert.equal(h.app.topicRecords_(s.id)['About parking'].labels.ko, '[ko] About parking');
});

test('the grouping prompt asks for display translations without touching the grouping rules', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is hard');
  h.app.clusterQuestions();
  const prompt = h.env.geminiCalls[0].prompt;
  assert.match(prompt, /translation into Korean and Spanish/);
  assert.match(prompt, /always use the\s+English label in the assignments/);
  assert.match(prompt, /Topic labels must always be written in English/);
  assert.ok(h.env.geminiCalls[0].schema.properties.labels, 'labels requested via responseSchema');
});

test('now answering reaches the room screen and phones in every language', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is hard');
  h.app.clusterQuestions();

  h.as(MOD);
  h.app.mergeTopic(s.id, 'About parking');
  assert.equal(h.app.setNowAnswering(s.id, 'About parking').nowAnswering, 'About parking');

  const screen = h.app.getRoomScreen(s.id).nowAnswering;
  assert.deepEqual(screen.labels, { en: 'About parking', ko: '[ko] About parking', es: '[es] About parking' });
  assert.deepEqual(screen.merged, { en: 'What does everyone want to know?', ko: '[ko] merged', es: '[es] merged' });

  const d = h.join(s);
  const phone = h.anonymous().app.getTopics(s.id, d.deviceId);
  assert.equal(phone.nowAnswering.topic, 'About parking', 'cache was invalidated');

  h.as(MOD).app.setNowAnswering(s.id, null);
  assert.equal(h.app.getRoomScreen(s.id).nowAnswering, null);
  assert.equal(h.anonymous().app.getTopics(s.id, d.deviceId).nowAnswering, null);
});

test('merge prompt keeps the do-not-soften rule for its translations too', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Leadership ignored us');
  h.app.clusterQuestions();
  h.as(MOD).app.mergeTopic(s.id, 'About leadership');
  const merge = h.env.geminiCalls[1];
  assert.match(merge.prompt, /Do not soften criticism/);
  assert.match(merge.prompt, /do not soften it in translation either/);
});

test('only assigned moderators can set now answering, and not on ended sessions', () => {
  const { h, s } = setup();
  h.as('other@example.org');
  assert.throws(() => h.app.setNowAnswering(s.id, 'x'), /not a moderator/);
  h.as(h.env.owner).app.endSession(s.id);
  h.as(MOD);
  assert.throws(() => h.app.setNowAnswering(s.id, 'x'), /has ended/);
  assert.equal(h.app.getSession_(s.id).nowAnswering, null, 'ending clears it');
});

test('summary email and CSV include me too counts', () => {
  const { h, s } = setup();
  h.app.saveSession({ id: s.id, name: 'Topics', access: 'link', moderators: [MOD], emailOnEnd: true });
  h.ask(s, h.join(s), 'Parking is hard');
  h.app.clusterQuestions();
  const d = h.join(s);
  h.anonymous().app.meToo(s.id, d.deviceId, 'About parking');
  h.as(h.env.owner).app.endSession(s.id);
  const mail = h.env.outbox[0];
  assert.match(mail.htmlBody, /\(1 · 1 me too\)/);
  assert.match(mail.attachments[0].getDataAsString(), /"Me too \(topic\)"/);
});
