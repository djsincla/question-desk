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

  h.app.clusterQuestions();
  board = h.app.getBoard(a.id);
  assert.deepEqual(board.topics.map((t) => [t.topic, t.count]), [['About parking', 2]]);
  assert.equal(board.unsorted.length, 0);
  assert.deepEqual(h.app.getBoard(b.id).topics.map((t) => t.topic), ['About funding']);
});

test('clustering sends each session only its own existing topic labels', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Parking is a problem');
  h.app.clusterQuestions();
  h.env.geminiCalls.length = 0;

  h.ask(b, h.join(b), 'Transport options?');
  h.app.clusterQuestions();
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
  h.app.clusterQuestions();
  assert.equal(h.env.geminiCalls.length, 1);
  assert.match(h.env.geminiCalls[0].prompt, /Question in B/);
});

test('a Gemini failure in one session does not stop the others', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Breaks Gemini somehow');
  h.ask(b, h.join(b), 'Works fine here');
  const normal = h.env.gemini;
  h.env.gemini = (call) => (/Breaks Gemini/.test(call.prompt) ? { status: 404, text: 'model not found' } : normal(call));

  h.app.clusterQuestions();
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
    const id = call.prompt.match(/\n([a-f0-9]{8}): /)[1];
    return { assignments: [{ id, topic: '=cmd()', language: '+English', translation: '@translated' }] };
  };
  h.app.clusterQuestions();
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
  h.app.endSession(a.id);
  h.as(MOD);
  assert.equal(h.app.getBoard(a.id).session.status, 'ended');
  assert.throws(() => h.app.setStatus(a.id, [id], 'answered'), /has ended/);
});

test('merged questions are stored per session and topic', () => {
  const { h, a, b } = setup();
  h.ask(a, h.join(a), 'Parking is a problem');
  h.ask(b, h.join(b), 'Parking in B too');
  h.app.clusterQuestions();

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
  h.app.clusterQuestions();
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
