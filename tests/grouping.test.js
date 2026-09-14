'use strict';
/** Grouping by hand, ungrouping, the automatic grouping switch, and answering single questions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

function setup(extra) {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session(Object.assign({ name: 'Grouping', access: 'link', active: true, moderators: [MOD] }, extra || {}));
  return { h, s };
}
const ids = (h, s) => Object.fromEntries(h.questions().rows.slice(1).filter((r) => r[8] === s.id).map((r) => [r[3], r[0]]));

test('a question can be answered right away, without waiting for grouping', () => {
  const { h, s } = setup();
  const r = h.screenKey(s);
  h.ask(s, h.join(s), 'Is there parking nearby?');
  const qid = ids(h, s)['Is there parking nearby?'];
  h.as(MOD);
  let board = h.app.setNowAnswering(s.id, null, qid);
  assert.equal(board.nowAnsweringQuestion, qid);
  assert.equal(board.nowAnswering, null);
  h.anonymous();
  const screen = h.app.getRoomScreen(s.id, 'full', r).nowAnswering;
  assert.equal(screen.labels.en, 'Is there parking nearby?');
  assert.equal(screen.question, true);
  assert.equal(h.app.getTopics(s.id, h.join(s).deviceId).nowAnswering.labels.en, 'Is there parking nearby?');

  // Marking it answered takes it off the room screen.
  h.as(MOD);
  board = h.app.setStatus(s.id, [qid], 'answered');
  assert.equal(board.nowAnsweringQuestion, null);
  h.anonymous();
  assert.equal(h.app.getRoomScreen(s.id, 'full', r).nowAnswering, null);
});

test('questions can be grouped by hand, moved between topics, and still get translated', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is a problem');
  h.ask(s, h.join(s), 'Where do cars go?');
  h.ask(s, h.join(s), 'Respite hours are short');
  const q = ids(h, s);
  h.as(MOD);
  let board = h.app.groupQuestions(s.id, [q['Parking is a problem'], q['Where do cars go?']], 'Parking and cars');
  assert.deepEqual(board.topics.map((t) => [t.topic, t.count]), [['Parking and cars', 2]]);
  assert.equal(board.unsorted.length, 1);

  h.anonymous();
  h.app.clusterAll_();
  const rows = h.questions().rows.slice(1);
  const cars = rows.find((r) => r[3] === 'Where do cars go?');
  assert.equal(cars[5], 'Parking and cars', 'automatic grouping kept the facilitator\'s topic');
  assert.equal(cars[6], 'English', 'but still translated it');
  assert.equal(rows.find((r) => r[3] === 'Respite hours are short')[5], 'About respite', 'others grouped automatically');
  assert.ok(h.env.geminiCalls[0].prompt.includes('Parking and cars'), 'the chosen topic is offered to Gemini as existing');

  h.as(MOD);
  board = h.app.groupQuestions(s.id, [q['Where do cars go?']], 'About respite');
  assert.deepEqual(board.topics.map((t) => [t.topic, t.count]).sort(), [['About respite', 2], ['Parking and cars', 1]]);
  assert.throws(() => h.app.groupQuestions(s.id, [q['Where do cars go?']], '  '), /topic name/);
  h.anonymous();
  assert.throws(() => h.app.groupQuestions(s.id, [q['Where do cars go?']], 'X'), /not a QA Facilitator/);
});

test('ungrouped questions stay ungrouped; Group now can group them again', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is a problem');
  h.app.clusterAll_();
  const qid = ids(h, s)['Parking is a problem'];
  h.as(MOD);
  let board = h.app.ungroupQuestions(s.id, [qid]);
  assert.equal(board.topics.length, 0);
  assert.equal(board.unsorted[0].id, qid);
  h.anonymous();
  h.env.geminiCalls.length = 0;
  h.app.clusterAll_();
  assert.equal(h.env.geminiCalls.length, 0, 'the every-minute grouping leaves it alone');
  h.as(MOD);
  h.app.groupNow(s.id);
  assert.equal(h.app.getBoard(s.id).topics[0].topic, 'About parking', 'Group now groups it');
});

test('with automatic grouping off, questions are translated but not grouped', () => {
  const { h, s } = setup();
  h.as(MOD);
  assert.equal(h.app.getBoard(s.id).autoGroup, true, 'on by default');
  h.app.setAutoGroup(s.id, false);
  h.anonymous();
  h.ask(s, h.join(s), 'Parking is a problem');
  h.app.clusterAll_();
  const row = h.questions().rows.slice(1).find((r) => r[8] === s.id);
  assert.equal(row[5], '', 'not grouped');
  assert.equal(row[6], 'English', 'translated');
  assert.deepEqual(Object.keys(h.app.topicRecords_(s.id)), [], 'no topic records for suggestions nobody used');
  h.env.geminiCalls.length = 0;
  h.app.clusterAll_();
  assert.equal(h.env.geminiCalls.length, 0, 'not sent again');

  h.as(MOD);
  let board = h.app.getBoard(s.id);
  assert.equal(board.autoGroup, false);
  assert.equal(board.unsorted[0].lang, 'English');
  h.app.groupNow(s.id);
  assert.equal(h.app.getBoard(s.id).topics.length, 1, 'Group now still groups on request');
});

test('Answer now can show the topic on phones automatically, and answered topics leave phones', () => {
  const { h, s } = setup();
  const d = h.join(s);
  h.ask(s, d, 'Parking is a problem');
  h.ask(s, h.join(s), 'Parking again please');
  h.app.clusterAll_();
  h.as(MOD);
  const topic = h.app.getBoard(s.id).topics[0].topic;
  h.app.setNowAnswering(s.id, topic);
  h.anonymous();
  assert.equal(h.app.getTopics(s.id, d.deviceId).topics.length, 0, 'switch off: not shown until approved');

  h.as(MOD);
  h.app.setNowAnswering(s.id, null);
  let board = h.app.setAutoShowOnPhones(s.id, true);
  assert.equal(board.autoShowOnPhones, true);
  h.app.setNowAnswering(s.id, topic);
  assert.equal(h.app.getBoard(s.id).topics[0].shown, true);
  h.anonymous();
  assert.equal(h.app.getTopics(s.id, d.deviceId).topics[0].topic, topic, 'switch on: shown with Answer now');

  // Answering every question in it ends Answer now and takes it off phones.
  h.as(MOD);
  board = h.app.setStatus(s.id, h.app.getBoard(s.id).topics[0].questions.map((q) => q.id), 'answered');
  assert.equal(board.nowAnswering, null);
  h.anonymous();
  assert.equal(h.app.getTopics(s.id, d.deviceId).topics.length, 0);
  assert.equal(h.app.getTopics(s.id, d.deviceId).nowAnswering, null);
});

test('answering one question of a live topic keeps the topic up while others are open', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Parking is a problem');
  h.ask(s, h.join(s), 'Parking again please');
  h.app.clusterAll_();
  h.as(MOD);
  const t = h.app.getBoard(s.id).topics[0];
  h.app.setNowAnswering(s.id, t.topic);
  assert.equal(h.app.setStatus(s.id, [t.questions[0].id], 'answered').nowAnswering, t.topic);
  assert.equal(h.app.setStatus(s.id, [t.questions[1].id], 'dismissed').nowAnswering, null);
});

test('a question that is not in a topic can go on phones for Me too, translated, like a topic', () => {
  const { h, s } = setup();
  const d = h.join(s);
  h.ask(s, d, 'Is there parking nearby?');
  const qid = ids(h, s)['Is there parking nearby?'];
  h.as(MOD);
  let board = h.app.getBoard(s.id);
  assert.equal(board.unsorted[0].shown, false);
  board = h.app.setQuestionShown(s.id, qid, true);
  assert.equal(board.unsorted[0].shown, true);
  assert.ok(h.env.geminiCalls.length >= 1, 'translated for phones');

  h.anonymous();
  let phone = h.app.getTopics(s.id, d.deviceId);
  assert.equal(phone.topics.length, 1);
  const entry = phone.topics[0];
  assert.equal(entry.topic, 'q:' + qid);
  assert.equal(entry.labels.en, 'Is there parking nearby?');
  assert.ok(entry.labels.ko && entry.labels.es, 'labels in the session languages');
  const other = h.join(s);
  assert.equal(h.app.meToo(s.id, other.deviceId, entry.topic).ok, true);
  assert.equal(h.app.getTopics(s.id, other.deviceId).topics[0].count, 2);

  // Automatic grouping leaves it alone, so it doesn't vanish from phones mid-vote.
  h.ask(s, h.join(s), 'Where do we park?');
  h.app.clusterAll_();
  h.as(MOD);
  board = h.app.getBoard(s.id);
  const single = board.unsorted.find((q) => q.id === qid);
  assert.ok(single, 'still on its own');
  assert.equal(single.votes, 1);

  // Hidden again: off phones.
  h.app.setQuestionShown(s.id, qid, false);
  h.anonymous();
  assert.equal(h.app.getTopics(s.id, d.deviceId).topics.some((t) => t.topic === 'q:' + qid), false);

  // Answered: off phones, like a fully answered topic.
  h.as(MOD);
  h.app.setQuestionShown(s.id, qid, true);
  h.app.setStatus(s.id, [qid], 'answered');
  h.anonymous();
  assert.equal(h.app.getTopics(s.id, d.deviceId).topics.some((t) => t.topic === 'q:' + qid), false);
});

test('Answer now on a single question shows it on phones when the switch is on; grouping it carries its Me too', () => {
  const { h, s } = setup();
  const d = h.join(s);
  h.ask(s, d, 'Can we get the slides?');
  const qid = ids(h, s)['Can we get the slides?'];
  h.as(MOD);
  h.app.setNowAnswering(s.id, null, qid);
  h.anonymous();
  assert.equal(h.app.getTopics(s.id, d.deviceId).topics.length, 0, 'switch off: not on phones');

  h.as(MOD);
  h.app.setAutoShowOnPhones(s.id, true);
  h.app.setNowAnswering(s.id, null, qid);
  assert.equal(h.app.getBoard(s.id).unsorted[0].shown, true);
  h.anonymous();
  const key = h.app.getTopics(s.id, d.deviceId).topics[0].topic;
  assert.equal(key, 'q:' + qid);
  h.app.meToo(s.id, h.join(s).deviceId, key);
  h.app.meToo(s.id, h.join(s).deviceId, key);

  // Grouped by hand: the topic goes on phones and keeps the two Me too taps.
  h.as(MOD);
  const board = h.app.groupQuestions(s.id, [qid], 'Slides and handouts');
  const topic = board.topics.find((t) => t.topic === 'Slides and handouts');
  assert.equal(topic.shown, true);
  assert.equal(topic.votes, 2);
  h.anonymous();
  const phone = h.app.getTopics(s.id, d.deviceId).topics;
  assert.deepEqual(phone.map((t) => t.topic), ['Slides and handouts']);
  assert.equal(phone[0].count, 3);
});

test('showing a single question on phones is for its session\'s QA Facilitators only, and not for dismissed questions', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Dismiss me');
  const qid = ids(h, s)['Dismiss me'];
  h.anonymous();
  assert.throws(() => h.app.setQuestionShown(s.id, qid, true));
  h.as('someone@example.org');
  assert.throws(() => h.app.setQuestionShown(s.id, qid, true));
  h.as(MOD);
  h.app.setStatus(s.id, [qid], 'dismissed');
  assert.throws(() => h.app.setQuestionShown(s.id, qid, true), /no longer in the queue/);
});

test('the summary counts Me too on single questions shown on phones', () => {
  const { h, s } = setup();
  h.ask(s, h.join(s), 'Is lunch provided?');
  const qid = ids(h, s)['Is lunch provided?'];
  h.as(MOD);
  h.app.setQuestionShown(s.id, qid, true);
  h.anonymous();
  h.app.meToo(s.id, h.join(s).deviceId, 'q:' + qid);
  const content = h.app.summaryContent_(h.app.getSession_(s.id), h.app.brand_(h.app.getSession_(s.id)));
  assert.match(content.body, /1 me too · shown on phones/);
  const row = content.rows.find((r) => r[0] === qid);
  assert.equal(row[8], 1);
  assert.equal(row[9], 'yes');
});
