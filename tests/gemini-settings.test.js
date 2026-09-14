'use strict';
/** Admin → Health → Gemini: model, thinking per task, temperature and batch size, applied immediately. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

function setup() {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Gemini', access: 'link', active: true, moderators: [MOD] });
  return { h, s };
}

test('defaults: the configured model, model-chosen thinking for grouping, low for merging and translating', () => {
  const { h } = setup();
  const state = h.app.adminState();
  assert.deepEqual(state.gemini, {
    model: h.app.CONFIG.model,
    thinking: { grouping: 'default', merging: 'low', translating: 'low' },
    temperature: 0.1,
    batchSize: h.app.CONFIG.clusterBatchSize
  });
  assert.deepEqual(state.geminiDefaults, state.gemini);
});

test('saved settings apply to the very next Gemini request, for each task', () => {
  const { h, s } = setup();
  h.app.saveGeminiSettings({ model: 'gemini-9-flash', thinking: { grouping: 'high', merging: 'minimal', translating: 'medium' }, temperature: 0.3, batchSize: 10 });

  h.ask(s, h.join(s), 'Parking is a problem');
  h.app.clusterAll_();
  const grouping = h.env.geminiCalls[0];
  assert.equal(grouping.model, 'gemini-9-flash');
  assert.deepEqual(grouping.thinking, { thinkingLevel: 'high' });
  assert.equal(grouping.temperature, 0.3);

  h.as(MOD);
  const topic = h.app.getBoard(s.id).topics[0].topic;
  h.env.geminiCalls.length = 0;
  h.app.mergeTopic(s.id, topic);
  assert.deepEqual(h.env.geminiCalls[0].thinking, { thinkingLevel: 'minimal' });

  h.ask(s, h.join(s), 'Is lunch provided?');
  const qid = h.questions().rows.find((r) => r[3] === 'Is lunch provided?')[0];
  h.env.geminiCalls.length = 0;
  h.app.setQuestionShown(s.id, qid, true);
  assert.deepEqual(h.env.geminiCalls[0].thinking, { thinkingLevel: 'medium' });

  // "Default" sends no thinking setting at all; changing it back applies at once.
  h.as('owner@example.org');
  h.app.saveGeminiSettings({ model: 'gemini-9-flash', thinking: { grouping: 'high', merging: 'default', translating: 'medium' }, temperature: 0, batchSize: 10 });
  h.as(MOD);
  h.env.geminiCalls.length = 0;
  h.app.mergeTopic(s.id, topic);
  assert.equal(h.env.geminiCalls[0].thinking, null);
  assert.equal(h.env.geminiCalls[0].temperature, 0);

  // Reset.
  h.as('owner@example.org');
  h.app.saveGeminiSettings({ reset: true });
  assert.equal(h.app.adminState().gemini.model, h.app.CONFIG.model);
});

test('questions per grouping request follows the setting', () => {
  const { h, s } = setup();
  h.app.saveGeminiSettings({ model: h.app.CONFIG.model, thinking: { grouping: 'default', merging: 'low', translating: 'low' }, temperature: 0.1, batchSize: 5 });
  for (let i = 0; i < 12; i++) h.ask(s, h.join(s), 'Question number ' + i + ' about parking');
  h.env.geminiCalls.length = 0;
  h.app.clusterSession_(s.id);
  const sent = h.env.geminiCalls[0].prompt.split('\n').filter((line) => /^\{"id"/.test(line));
  assert.equal(sent.length, 5);
});

test('settings are checked, admin-only, and logged', () => {
  const { h } = setup();
  const good = { model: 'gemini-3.5-flash', thinking: { grouping: 'default', merging: 'low', translating: 'low' }, temperature: 0.1, batchSize: 25 };
  [
    [{ model: 'gpt-4' }, /Gemini model name/],
    [{ model: 'gemini-x"; drop' }, /Gemini model name/],
    [{ thinking: { grouping: 'extreme', merging: 'low', translating: 'low' } }, /thinking level for grouping/],
    [{ temperature: 2 }, /between 0 and 1/],
    [{ batchSize: 500 }, /5 to 100/],
    [{ batchSize: 7.5 }, /5 to 100/]
  ].forEach(([change, message]) => assert.throws(() => h.app.saveGeminiSettings(Object.assign({}, good, change)), message));
  // "models/…" as copied from Google's list is accepted.
  assert.equal(h.app.saveGeminiSettings(Object.assign({}, good, { model: 'models/gemini-3.5-pro' })).gemini.model, 'gemini-3.5-pro');
  assert.match(h.app.getActivity().entries[0].action, /Gemini settings changed/);

  h.as(MOD);
  assert.throws(() => h.app.saveGeminiSettings(good), /Only administrators/);
  assert.throws(() => h.app.testGeminiSettings(good), /Only administrators/);
  assert.throws(() => h.app.listGeminiModels(), /Only administrators/);
  h.anonymous();
  assert.throws(() => h.app.saveGeminiSettings(good));
});

test('a thinking level the model refuses is retried without it, and the test button reports that', () => {
  const { h } = setup();
  h.env.gemini = (call) => call.thinking
    ? { status: 400, text: '{"error":{"message":"Thinking level is not supported for this model."}}' }
    : { question: 'One question.' };
  const out = h.app.testGeminiSettings({ model: 'gemini-2.0-flash', thinking: { grouping: 'default', merging: 'low', translating: 'low' }, temperature: 0.1, batchSize: 25 });
  assert.equal(out.model, 'gemini-2.0-flash');
  assert.deepEqual(out.results.map((r) => [r.task, r.thinking, r.ok, r.retried]), [
    ['grouping', 'default', true, false],
    ['merging', 'low', true, true],
    ['translating', 'low', true, true]
  ]);
  assert.equal(h.env.geminiCalls.length, 3, 'the same level is only tried once');
  assert.equal(h.app.adminState().gemini.model, h.app.CONFIG.model, 'testing saves nothing');
});

test('the model list shows models this key can use to generate content', () => {
  const { h } = setup();
  h.env.geminiModels = { models: [
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] }
  ] };
  assert.deepEqual(h.app.listGeminiModels(), { ok: true, models: [{ name: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }] });
  h.env.geminiModels = { status: 403 };
  assert.equal(h.app.listGeminiModels().ok, false);
});
