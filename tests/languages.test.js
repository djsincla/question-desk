'use strict';
/** Languages per event (or site), the high-contrast room screen, and "Answered" on your own phone. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

test('an event chooses its languages; others use the site default; English is always included', () => {
  const h = createApp().install({ moderators: [MOD] });
  assert.deepEqual(h.app.adminState().siteLanguages, ['en', 'ko', 'es']);
  const eid = h.app.saveEvent({ name: 'Community Day', languages: ['vi', 'zh'] }).savedEventId;
  assert.deepEqual(h.app.getEvent_(eid).languages, ['en', 'vi', 'zh'], 'English added first');

  const inEvent = h.session({ name: 'In event', access: 'link', active: true, moderators: [MOD], eventId: eid });
  const plain = h.session({ name: 'Plain', access: 'link', active: true, moderators: [MOD] });
  assert.deepEqual(h.app.languagesFor_(h.app.getSession_(inEvent.id)), ['en', 'vi', 'zh']);
  assert.deepEqual(h.app.languagesFor_(h.app.getSession_(plain.id)), ['en', 'ko', 'es']);

  h.app.saveSiteLanguages(['hy', 'tl']);
  assert.deepEqual(h.app.languagesFor_(h.app.getSession_(plain.id)), ['en', 'hy', 'tl']);
  h.app.saveEvent({ id: eid, name: 'Community Day', languages: null });
  assert.deepEqual(h.app.languagesFor_(h.app.getSession_(inEvent.id)), ['en', 'hy', 'tl'], 'back to the site\'s');

  assert.throws(() => h.app.saveEvent({ name: 'Too many', languages: ['ko', 'es', 'zh', 'vi'] }), /at most 4 languages/);
  assert.throws(() => h.app.saveSiteLanguages(['fr']), /Unknown language: fr/);
  h.as(MOD);
  assert.throws(() => h.app.saveSiteLanguages(['ko']), /Only administrators/);
});

test('phones, room screen, landing page and Gemini follow the session\'s languages', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Community Day', languages: ['vi', 'zh'] }).savedEventId;
  const s = h.session({ name: 'Talk', access: 'link', active: true, moderators: [MOD], eventId: eid });
  const r = h.screenKey(s);
  const d = h.join(s);
  h.anonymous();
  h.app.submitQuestion(s.id, d.deviceId, 'Is there parking nearby?', d.credential);
  h.app.clusterAll_();

  const prompt = h.env.geminiCalls[0].prompt;
  assert.match(prompt, /translation into Vietnamese and Chinese \(Simplified\)/);
  assert.doesNotMatch(prompt, /Korean|Spanish/);

  const ask = h.app.doGet({ parameter: { s: s.id, k: h.app.getSession_(s.id).linkKey } });
  assert.deepEqual(ask.data.languages.map((l) => l.code), ['en', 'vi', 'zh']);
  assert.equal(ask.data.languages[1].native, 'Tiếng Việt');
  assert.deepEqual(h.app.doGet({ parameter: { view: 'present', s: s.id, r } }).data.languages, ['en', 'vi', 'zh']);
  assert.deepEqual(h.app.doGet({ parameter: {} }).data.languages, ['en', 'ko', 'es'], 'landing page uses the site\'s');

  h.as(MOD);
  const topic = h.app.getBoard(s.id).topics[0];
  assert.deepEqual(topic.translations.map((t) => t.language), ['Vietnamese', 'Chinese (Simplified)']);
  h.app.setTopicShown(s.id, topic.topic, true);
  h.app.mergeTopic(s.id, topic.topic);
  assert.match(h.env.geminiCalls[h.env.geminiCalls.length - 1].prompt, /translate that question into Vietnamese and Chinese/);
  h.app.setNowAnswering(s.id, topic.topic);

  h.anonymous();
  const topics = h.app.getTopics(s.id, d.deviceId);
  assert.deepEqual(Object.keys(topics.topics[0].labels), ['en', 'vi', 'zh']);
  assert.equal(topics.topics[0].labels.vi, '[vi] ' + topic.topic);
  assert.deepEqual(Object.keys(h.app.getRoomScreen(s.id, 'full', r).nowAnswering.merged), ['en', 'vi', 'zh']);
});

test('adding a language to an event later fills it in on the next grouping without changing existing wording', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Grows', languages: ['ko'] }).savedEventId;
  const s = h.session({ name: 'Talk', access: 'link', active: true, moderators: [MOD], eventId: eid });
  h.ask(s, h.join(s), 'Parking is a problem');
  h.app.clusterAll_();
  h.app.saveEvent({ id: eid, name: 'Grows', languages: ['ko', 'vi'] });
  h.ask(s, h.join(s), 'Parking again please');
  const normal = h.env.gemini;
  h.env.gemini = (call) => { const out = normal(call); (out.labels || []).forEach((l) => { if (l.translations.ko) l.translations.ko = 'changed'; }); return out; };
  h.app.clusterAll_();
  const labels = h.app.topicRecords_(s.id)['About parking'].labels;
  assert.equal(labels.ko, '[ko] About parking', 'existing wording kept');
  assert.equal(labels.vi, '[vi] About parking', 'new language filled in');
});

test('every language has every phrase, in one catalog, and each page gets its part', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const h = createApp().install();
  const codes = Object.keys(h.app.CONFIG.languages);
  const TEXT = h.app.UI_TEXT;
  Object.keys(TEXT).forEach((part) => {
    const keys = Object.keys(TEXT[part].en);
    assert.deepEqual(Object.keys(TEXT[part]).sort(), codes.slice().sort(), part + ' covers exactly the offered languages');
    codes.forEach((code) => assert.deepEqual(keys.filter((k) => !TEXT[part][code][k]), [], part + '.' + code + ' is missing phrases'));
  });
  // Pages carry no phrase lists of their own: they read BOOT.text.
  ['Ask.html', 'Home.html', 'Present.html', 'Sheet.html'].forEach((file) => {
    assert.match(read(file), /BOOT\.text/, file);
    assert.doesNotMatch(read(file), /[\uac00-\ud7af]|[\u4e00-\u9fff]|[\u0530-\u058f]/, file + ' has translated text in it; move it to UI_TEXT');
  });
  const s = h.session({ name: 'Text', access: 'link', active: true });
  const r = h.screenKey(s);
  assert.deepEqual(h.app.doGet({ parameter: { view: 'present', s: s.id, r } }).data.text, TEXT.screen);
  assert.deepEqual(h.app.doGet({ parameter: { s: s.id, k: h.app.getSession_(s.id).linkKey } }).data.text, TEXT.ask);
  assert.deepEqual(h.app.doGet({ parameter: {} }).data.text, TEXT.home);
  assert.match(read('Ask.html'), /BOOT\.languages/);
});

test('the room screen can be high contrast', () => {
  const h = createApp().install();
  h.app.saveSession({ name: 'Bright', theme: 'contrast' });
  const s = h.app.adminState().sessions[0];
  assert.equal(s.theme, 'contrast');
  h.app.setSessionActive(s.id, true);
  assert.equal(h.app.getRoomScreen(s.id, 'full', h.screenKey(s)).theme, 'contrast');
  assert.equal(h.app.importSessionsCsv('Session,Room screen theme (dark, light or contrast)\nBright,contrast', {}, true).rows[0].action, 'update');
});

test('a phone learns which of its own questions were answered, and nobody else\'s', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Mine', access: 'link', active: true, moderators: [MOD], cooldownSeconds: 0 });
  const me = h.join(s);
  const other = h.join(s);
  h.anonymous();
  const mine = h.app.submitQuestion(s.id, me.deviceId, 'My parking question', me.credential).id;
  const theirs = h.app.submitQuestion(s.id, other.deviceId, 'Their parking question', other.credential).id;
  h.as(MOD);
  h.app.setStatus(s.id, [mine, theirs], 'answered');
  h.anonymous();
  assert.deepEqual(h.app.getTopics(s.id, me.deviceId).mineAnswered, [mine]);
  assert.deepEqual(h.app.getTopics(s.id, other.deviceId).mineAnswered, [theirs]);
  h.as(MOD);
  h.app.setStatus(s.id, [mine], 'new');
  h.anonymous();
  assert.deepEqual(h.app.getTopics(s.id, me.deviceId).mineAnswered, [], 'reopening clears it right away');
});
