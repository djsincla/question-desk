'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

function setup() {
  const h = createApp().install({ moderators: [MOD] });
  const a = h.session({ name: 'A', access: 'link', active: true, moderators: [MOD] });
  const b = h.session({ name: 'B', access: 'link', active: true, moderators: [MOD] });
  return { h, a, b };
}

test('the board only shows its own session, grouped after clustering', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Parking is a problem');
  h.ask(a, h.join(a), 'Parking again please');
  h.ask(b, h.join(b), 'Funding for next year');

  h.as(MOD);
  let board = h.app.getBoard(a.id);
  assert.equal(board.unsorted.length, 2);
  assert.equal(board.topics.length, 0);

  h.app.clusterAll_();
  board = h.app.getBoard(a.id);
  assert.deepEqual(board.topics.map((t) => [t.topic, t.count]), [['About parking', 2]]);
  assert.equal(board.unsorted.length, 0);
  assert.deepEqual(h.app.getBoard(b.id).topics.map((t) => t.topic), ['About funding']);
});

test('clustering sends each session only its own existing topic labels', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Parking is a problem');
  h.app.clusterAll_();
  h.env.geminiCalls.length = 0;

  h.ask(b, h.join(b), 'Transport options?');
  h.app.clusterAll_();
  assert.equal(h.env.geminiCalls.length, 1);
  assert.match(h.env.geminiCalls[0].prompt, /Existing topic labels:\n\(none yet\)/);
  assert.doesNotMatch(h.env.geminiCalls[0].prompt, /About parking/);
});

test('the trigger skips inactive and ended sessions', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Question before pause');
  h.app.setSessionActive(a.id, false);
  h.ask(b, h.join(b), 'Question in B');
  h.env.geminiCalls.length = 0;
  h.app.clusterAll_();
  assert.equal(h.env.geminiCalls.length, 1);
  assert.match(h.env.geminiCalls[0].prompt, /Question in B/);
});

test('a Gemini failure in one session does not stop the others', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Breaks Gemini somehow');
  h.ask(b, h.join(b), 'Works fine here');
  const normal = h.env.gemini;
  h.env.gemini = (call) => (/Breaks Gemini/.test(call.prompt) ? { status: 404, text: 'model not found' } : normal(call));

  h.app.clusterAll_();
  h.as(MOD);
  assert.equal(h.app.getBoard(a.id).unsorted.length, 1);
  assert.equal(h.app.getBoard(b.id).topics.length, 1);
  assert.ok(h.env.logs.some((l) => /Gemini 404/.test(l)), 'the 404 is logged for the execution log');
  assert.throws(() => h.app.groupNow(a.id), /Grouping failed: Gemini 404 — model gemini-3\.5-flash not found/);
});

test('Group now only processes the chosen session', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Only this one');
  h.ask(b, h.join(b), 'Not this one');
  h.as(MOD);
  assert.equal(h.app.groupNow(a.id), 1);
  assert.equal(h.app.getBoard(b.id).unsorted.length, 1);
});

test('clustering output that looks like a formula is stored as text', () => {
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Something ordinary');
  h.env.gemini = (call) => {
    const id = call.prompt.match(/"id":"([a-f0-9]{8})"/)[1];
    return { assignments: [{ id, topic: '=cmd()', language: '+English', translation: '@translated' }] };
  };
  h.app.clusterAll_();
  assert.deepEqual(h.questions().formulas, []);
  h.as(MOD);
  assert.equal(h.app.getBoard(a.id).topics[0].topic, '=cmd()');
});

test('status changes only touch questions in the given session', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Question in A');
  h.ask(b, h.join(b), 'Question in B');
  const idB = h.questions().rows[2][0];

  h.as(MOD);
  h.app.setStatus(a.id, [idB], 'dismissed');
  assert.equal(h.app.getBoard(b.id).unsorted.length, 1, 'B untouched when addressed through A');

  const idA = h.questions().rows[1][0];
  h.app.setStatus(a.id, [idA], 'answered');
  assert.equal(h.app.getBoard(a.id).unsorted[0].status, 'answered');
  h.app.setStatus(a.id, [idA], 'dismissed');
  assert.equal(h.app.getBoard(a.id).unsorted.length, 0);
  assert.throws(() => h.app.setStatus(a.id, [idA], 'deleted'), /Unknown status/);
});

test('ended sessions are read-only for moderators', () => {
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Before the end');
  const id = h.questions().rows[1][0];
  h.app.endSession(a.id, h.app.getSession_(a.id).name);
  h.as(MOD);
  assert.equal(h.app.getBoard(a.id).session.status, 'ended');
  assert.throws(() => h.app.setStatus(a.id, [id], 'answered'), /has ended/);
});

test('merged questions are stored per session and topic', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Parking is a problem');
  h.ask(b, h.join(b), 'Parking in B too');
  h.app.clusterAll_();

  h.as(MOD);
  h.env.gemini = () => ({ question: 'What is being done about parking in A?' });
  assert.equal(h.app.mergeTopic(a.id, 'About parking').ok, true);
  h.env.gemini = () => ({ question: 'Rewritten for A.' });
  h.app.mergeTopic(a.id, 'About parking');

  assert.deepEqual(h.app.getBoard(a.id).merged, { 'About parking': 'Rewritten for A.' });
  assert.deepEqual(h.app.getBoard(b.id).merged, {});
  const rowsForA = h.topics().rows.filter((r) => r[0] === a.id && r[1] === 'About parking');
  assert.equal(rowsForA.length, 1, 'rewrite updates the topic row instead of appending');
});

test('merge and translate prompts keep the do-not-soften instruction', () => {
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Leadership ignored us');
  h.app.clusterAll_();
  h.as(MOD);
  h.app.mergeTopic(a.id, 'About leadership');
  const [cluster, merge] = h.env.geminiCalls;
  assert.match(cluster.prompt, /do not smooth over\s+or soften anything/);
  assert.match(merge.prompt, /Do not soften criticism/);
  assert.match(cluster.prompt, /Topic labels must always be written in English/);
});

test('pausing is per session', () => {
  const { h, a, b } = setup();
  h.as(MOD);
  h.app.setBoardOpen(a.id, false);
  assert.equal(h.app.getBoard(a.id).open, false);
  assert.equal(h.app.getBoard(b.id).open, true);
});

// ------------------------------------------------------------ speed and ordering

test('a queue button opens the spreadsheet once and reads each sheet at most once', () => {
  const { h, a } = setup();
  for (let i = 0; i < 5; i++) h.ask(a, h.join(a), 'Parking question ' + i);
  h.app.clusterAll_();
  h.as(MOD);
  const id = h.questions().rows[1][0];

  const measure = (fn) => { h.env.opens = 0; h.env.sheetReads = 0; fn(); return [h.env.opens, h.env.sheetReads]; };
  const [opens, reads] = measure(() => h.app.setTopicShown(a.id, 'About parking', true));
  assert.equal(opens, 1, 'setTopicShown opens the spreadsheet once');
  assert.ok(reads <= 3, 'setTopicShown reads ' + reads + ' times (questions, topics, and topics again under the lock)');
  // The board is cached per session: refreshes after the one that followed a change read nothing.
  assert.deepEqual(measure(() => h.app.getBoard(a.id)), [0, 0], 'getBoard from the cache: no spreadsheet at all');
  h.app.invalidateTopics_(a.id);
  assert.deepEqual(measure(() => h.app.getBoard(a.id)), [1, 2], 'getBoard after a change: one open, questions + topics');
  const [o2, r2] = measure(() => h.app.setStatus(a.id, [id], 'answered'));
  assert.equal(o2, 1);
  assert.ok(r2 <= 3, 'setStatus reads ' + r2);
});

test('answered questions and topics sink to the bottom; dismissed ones are kept and restorable', () => {
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Parking one'); h.advance(5);
  h.ask(a, h.join(a), 'Parking two'); h.advance(5);
  h.ask(a, h.join(a), 'Funding one'); h.advance(5);
  h.ask(a, h.join(a), 'Funding two'); h.advance(5);
  h.ask(a, h.join(a), 'Funding three');
  h.app.clusterAll_();
  h.as(MOD);
  const idOf = (text) => h.questions().rows.find((r) => r[3] === text)[0];

  let board = h.app.setStatus(a.id, [idOf('Funding one')], 'answered');
  const funding = board.topics.find((t) => t.topic === 'About funding');
  assert.deepEqual(funding.questions.map((q) => q.text), ['Funding two', 'Funding three', 'Funding one'], 'answered sinks within its topic');

  board = h.app.setStatus(a.id, [idOf('Funding two'), idOf('Funding three')], 'answered');
  assert.deepEqual(board.topics.map((t) => [t.topic, t.answered]), [['About parking', false], ['About funding', true]], 'fully answered topic sinks');

  board = h.app.setStatus(a.id, [idOf('Parking two')], 'dismissed');
  assert.deepEqual(board.dismissed.map((q) => q.text), ['Parking two']);
  assert.deepEqual(board.topics[0].questions.map((q) => q.text), ['Parking one']);

  board = h.app.setStatus(a.id, [idOf('Parking two')], 'new');
  assert.deepEqual(board.dismissed, [], 'restored');
  assert.deepEqual(board.topics[0].questions.map((q) => q.text), ['Parking one', 'Parking two']);
});

test('the room screen checks for changes every 5 seconds', () => {
  const h = createApp().install();
  const room = h.session({ name: 'Room', active: true });
  const link = h.session({ name: 'Link', access: 'link', active: true });
  assert.ok(h.app.getRoomScreen(room.id).refreshInSeconds <= 5);
  assert.equal(h.app.getRoomScreen(link.id).refreshInSeconds, 5);
});

test('the queue board is shared from the cache and always fresh after a change', () => {
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Parking question one');
  h.app.clusterAll_();
  h.as(MOD);
  const first = h.app.getBoard(a.id);
  h.env.opens = 0;
  for (let i = 0; i < 5; i++) h.app.getBoard(a.id);
  assert.equal(h.env.opens, 0, 'five refreshes, no spreadsheet reads');

  // Every kind of change shows up on the very next refresh.
  const qid = first.topics[0].questions[0].id;
  h.app.setStatus(a.id, [qid], 'answered');
  assert.equal(h.app.getBoard(a.id).topics[0].questions[0].status, 'answered');
  h.anonymous();
  h.ask(a, h.join(a), 'A brand new question');
  h.as(MOD);
  assert.ok(h.app.getBoard(a.id).unsorted.some((q) => q.text === 'A brand new question'), 'new questions from the inbox');
  h.anonymous();
  h.app.meToo(a.id, h.join(a).deviceId, 'About parking');   // not shown: refused, no change
  h.as(MOD);
  h.app.setStatus(a.id, [qid], 'new');   // fully answered topics leave phones
  h.app.setTopicShown(a.id, 'About parking', true);
  h.anonymous();
  h.app.meToo(a.id, h.join(a).deviceId, 'About parking');
  h.as(MOD);
  assert.equal(h.app.getBoard(a.id).topics[0].votes, 1, 'Me too counts are always fresh');
});

test('merging asks Gemini to think less, retries without that if refused, and says why a merge failed', () => {
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Parking is a problem');
  h.app.clusterAll_();
  h.as(MOD);
  assert.equal(h.env.geminiCalls[0].thinking, null, 'grouping keeps the default thinking');

  h.env.geminiCalls.length = 0;
  h.env.gemini = () => ({ question: 'What is being done about parking?' });
  assert.equal(h.app.mergeTopic(a.id, 'About parking').ok, true);
  assert.deepEqual(h.env.geminiCalls[0].thinking, { thinkingLevel: 'low' }, 'a facilitator is waiting: think less');

  // A model that doesn't accept the setting: sent again without it, and the merge still works.
  h.env.geminiCalls.length = 0;
  h.env.gemini = (call) => call.thinking
    ? { status: 400, text: '{"error":{"message":"Invalid JSON payload: thinking_level is not supported for this model"}}' }
    : { question: 'Rewritten.' };
  assert.equal(h.app.mergeTopic(a.id, 'About parking').ok, true);
  assert.deepEqual(h.env.geminiCalls.map((c) => !!c.thinking), [true, false]);

  // Failures say why, in words a facilitator can act on.
  h.env.gemini = () => ({ status: 429, text: 'quota' });
  assert.deepEqual(h.app.mergeTopic(a.id, 'About parking'), { ok: false, error: 'Gemini is busy or out of quota. Try again in a minute.' });
  h.env.gemini = () => ({ status: 503, text: 'unavailable' });
  assert.match(h.app.mergeTopic(a.id, 'About parking').error, /didn't answer/);
  h.env.gemini = () => ({ nothing: true });
  assert.match(h.app.mergeTopic(a.id, 'About parking').error, /couldn't be used/);
  assert.match(h.app.mergeTopic(a.id, 'No such topic').error, /no questions/);
});

test('a board read before a change can never be cached after it (dismissed questions stayed dismissed)', () => {
  // Live: dismissing questions quickly, or with another queue refreshing, a request that read
  // the sheet just before a dismissal finished after it and put its old board back in the cache,
  // so the dismissed questions reappeared for up to 30 seconds.
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Parking question one');
  h.ask(a, h.join(a), 'Parking question two');
  h.app.clusterAll_();
  h.as(MOD);
  const board = h.app.getBoard(a.id);
  const [q1, q2] = board.topics[0].questions.map((q) => q.id);
  const staleBoard = h.cache.get('board:' + a.id);
  assert.ok(staleBoard, 'the board was cached');

  h.app.setStatus(a.id, [q1], 'dismissed');
  // The slow request lands now, writing what it read before the dismissal.
  h.cache.put('board:' + a.id, staleBoard, 30);

  const after = h.app.getBoard(a.id);
  assert.deepEqual(after.dismissed.map((q) => q.id), [q1], 'still dismissed');
  assert.deepEqual(after.topics[0].questions.map((q) => q.id), [q2]);

  // Phones: a topic list read before its approval can't be served after it either.
  h.app.setTopicShown(a.id, after.topics[0].topic, true);
  const phone = h.join(a);
  h.anonymous();
  assert.equal(h.app.getTopics(a.id, phone.deviceId).topics.length, 1, 'shown on phones');
  const shownTopics = h.cache.get('topics:' + a.id);
  assert.ok(shownTopics, 'the phone topic list was cached');
  h.as(MOD);
  h.app.setTopicShown(a.id, after.topics[0].topic, false);
  h.cache.put('topics:' + a.id, shownTopics, 30);
  h.anonymous();
  assert.equal(h.app.getTopics(a.id, phone.deviceId).topics.length, 0, 'hidden stays hidden on phones');
});

test('the QA Facilitator queue\'s browser tab is named "QA - " and the session name', () => {
  const { h, a } = setup();
  h.as(MOD);
  assert.equal(h.app.doGet({ parameter: { view: 'moderate', s: a.id } }).title, 'QA - ' + a.name);
});

test('a read-out question can be edited by hand (translated again) or removed', () => {
  const { h, a } = setup();
  h.ask(a, h.join(a), 'Parking is a problem');
  h.app.clusterAll_();
  h.as(MOD);
  h.app.mergeTopic(a.id, 'About parking');
  h.env.geminiCalls.length = 0;
  let board = h.app.setMergedQuestion(a.id, 'About parking', '  Where can families   park on event nights?  ');
  assert.equal(board.merged['About parking'], 'Where can families park on event nights?');
  const call = h.env.geminiCalls[0];
  assert.match(call.prompt, /do not\s+smooth over or soften anything/, 'translation keeps the do-not-soften instruction');
  assert.deepEqual(board.mergedTranslations['About parking'].map((t) => t.language), ['Korean', 'Spanish']);
  h.app.setNowAnswering(a.id, 'About parking');
  h.anonymous();
  assert.equal(h.app.getRoomScreen(a.id, 'full', h.screenKey(a)).nowAnswering.merged.es, '[es] Where can families park on event nights?');

  h.as(MOD);
  board = h.app.setMergedQuestion(a.id, 'About parking', '');
  assert.equal(board.merged['About parking'], undefined, 'removed');
  h.anonymous();
  assert.equal(h.app.getRoomScreen(a.id, 'full', h.screenKey(a)).nowAnswering.merged, null);
  assert.throws(() => h.app.setMergedQuestion(a.id, 'About parking', 'Sneaky'));
  h.as(MOD);
  assert.throws(() => h.app.setMergedQuestion(a.id, 'No such topic', 'x'), /no questions/);
});
