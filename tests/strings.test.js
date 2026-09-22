'use strict';
/**
 * The staff catalog (APP_TEXT in server/strings.js): what the queue, Admin, the coordinator
 * portal, the room screen footer and the server's own messages say, in each app language.
 * The audience's catalog is UI_TEXT, checked in languages.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./harness');
const { ROOT, SERVER_FILES } = require('./server-source');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SOURCE = read('server/strings.js');
const PAGES = ['Admin.html', 'Coordinator.html', 'Home.html', 'Moderate.html', 'Panel.html', 'Present.html', 'Sheet.html'];
const FILES = PAGES.concat(['Scripts.html'], SERVER_FILES);
const app = createApp().app;
const TEXT = app.APP_TEXT;

/** Every key the source names, in order, so a repeat is visible (Object.keys hides it). */
function keysInSource() {
  const block = SOURCE.split('const APP_TEXT = {')[1].split('\n};')[0];
  const found = [];
  block.replace(/^\s*'([^']+)':/gm, (whole, key) => found.push(key));
  return found;
}

/** Keys named by the pages (data-w attributes, W(), Wn()) and by the server (t_()). */
function keysNamed() {
  const named = [];
  FILES.forEach((file) => {
    const text = read(file);
    text.replace(/data-w(?:-ph|-t)?="([^"]+)"/g, (whole, key) => named.push(key));
    text.replace(/\b(?:W|Wn|t_)\(\s*'([^']+)'/g, (whole, key) => named.push(key));
  });
  return named;
}

/**
 * Every phrase key mentioned anywhere, including the ones a line picks between
 * (W(done ? 'a' : 'b')). Used to find phrases nothing asks for any more.
 */
function keysMentioned() {
  const mentioned = [];
  FILES.forEach((file) => {
    read(file).replace(/'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g, (whole, key) => {
      mentioned.push(key, key + '.one', key + '.other');
    });
    read(file).replace(/data-w(?:-ph|-t)?="([^"]+)"/g, (whole, key) => mentioned.push(key));
  });
  return mentioned;
}


test('no phrase is named twice: a repeat would win silently', () => {
  const seen = {};
  keysInSource().forEach((key) => {
    assert.ok(!seen[key], key + ' is in APP_TEXT twice; the second one silently wins');
    seen[key] = true;
  });
  assert.equal(keysInSource().length, Object.keys(TEXT).length);
});

test('every phrase has English, a sensible key, and the same placeholders in every language', () => {
  const codes = Object.keys(app.CONFIG.appLanguages);
  assert.ok(codes.indexOf('en') !== -1, 'English is always an app language');
  Object.keys(TEXT).forEach((key) => {
    assert.match(key, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, key + ' is not a dotted key');
    assert.ok(TEXT[key].en, key + ' has no English');
    const wanted = (TEXT[key].en.match(/\{\w+\}/g) || []).sort();
    Object.keys(TEXT[key]).forEach((code) => {
      assert.ok(codes.indexOf(code) !== -1, key + ' is in ' + code + ', which is not an app language');
      assert.deepEqual((TEXT[key][code].match(/\{\w+\}/g) || []).sort(), wanted,
        key + '.' + code + ' does not fill in the same values as the English');
    });
  });
});

test('a counted phrase has both forms, and neither is used on its own', () => {
  Object.keys(TEXT).forEach((key) => {
    const stem = key.replace(/\.(one|other)$/, '');
    if (stem === key) return;
    assert.ok(TEXT[stem + '.one'] && TEXT[stem + '.other'], stem + ' needs both .one and .other');
  });
  FILES.forEach((file) => {
    assert.doesNotMatch(read(file), /\bW\(\s*'[^']+\.(one|other)'/, file + ' asks for one plural form: use Wn()');
  });
});

test('every phrase the pages and the server ask for exists, and nothing sits unused', () => {
  keysNamed().forEach((key) => {
    assert.ok(TEXT[key] || TEXT[key + '.one'], 'no phrase ' + key + ', but something asks for it');
  });
  const mentioned = keysMentioned();
  assert.deepEqual(Object.keys(TEXT).filter((key) => mentioned.indexOf(key) === -1), [],
    'phrases nothing asks for: delete them or use them');
  // A key is written out, never built, or nothing above can see it.
  FILES.forEach((file) => assert.doesNotMatch(read(file), /\b(?:W|Wn|t_)\([^)\n]*\+/,
    file + ' builds a phrase key out of pieces: write the key out in full'));
});

test('the markup keeps the English, so an English page substitutes nothing', () => {
  PAGES.forEach((file) => {
    const html = read(file);
    html.replace(/<(\w+)[^>]*\sdata-w="([^"]+)"[^>]*>([^<]*)</g, (whole, tag, key, text) => {
      if (!TEXT[key]) return '';
      assert.equal(text.replace(/\s+/g, ' ').trim(), TEXT[key].en.replace(/\s+/g, ' ').trim(),
        file + ': the markup under ' + key + ' says something the catalog does not');
      return '';
    });
    [['data-w-ph', 'placeholder'], ['data-w-t', 'title']].forEach((pair) => {
      const re = new RegExp('<\\w+[^>]*\\s' + pair[0] + '="([^"]+)"[^>]*>', 'g');
      html.replace(re, (whole, key) => {
        const said = new RegExp('\\s' + pair[1] + '="([^"]*)"').exec(whole);
        if (TEXT[key] && said) assert.equal(said[1], TEXT[key].en, whole.slice(0, 60) + ' does not match ' + key);
        return '';
      });
    });
  });
});

test('what must stay English is not in the catalog', () => {
  const values = Object.keys(TEXT).map((key) => TEXT[key].en);
  const keep = []
    .concat(Object.keys(app.CONFIG.languages).map((c) => app.CONFIG.languages[c].name))
    .concat(app.HEADERS, app.TOPIC_HEADERS)
    .concat(app.SESSION_CSV.map((pair) => pair[0]))
    .concat(['Questions for the panel', 'Session created', 'Session ended', 'Answer now', 'Schedule (automatic)'])
    .concat(['Session not found.', 'This room screen link is out of date. Copy the new one from the Admin page.']);
  keep.forEach((word) => {
    assert.ok(values.indexOf(word) === -1,
      '"' + word + '" is compared as a value somewhere (a sheet header, a language name, a log entry, ' +
      'a grouping key); translating it breaks the app, so it must not be a phrase');
  });
});

test('a page is handed one language, and the catalog stays small enough to send', () => {
  const h = createApp().install();
  h.app.addPerson('coordinator', 'coord@example.org');
  const eid = h.app.saveEvent({ name: 'Fall Conference', coordinators: ['coord@example.org'] }).savedEventId;
  h.as('coord@example.org');
  const boot = h.app.doGet({ parameter: { view: 'coordinator', e: eid } }).data;
  assert.equal(boot.lang, 'en');
  assert.equal(boot.words['coord.sorted'], 'Sorted', 'the whole catalog, in one language');
  assert.equal(boot.words['coord.tally.other'], '{n} questions about running the event');
  assert.ok(!boot.words.en && !boot.words.es, 'not every language: the server already chose');
  assert.ok(JSON.stringify(boot.words).length < 60000, 'the catalog is getting too big to send with every page');

  // The participant page is not part of this: phones pick their own language from BOOT.text.
  const s = h.session({ name: 'Talk', access: 'link', active: true });
  assert.equal(h.app.doGet({ parameter: { s: s.id, k: h.app.getSession_(s.id).linkKey } }).data.words, undefined);
});

test('a person reads the app in their own language, and falls back to English until it is written', () => {
  const h = createApp().install();
  h.app.addPerson('coordinator', 'coord@example.org');
  const eid = h.app.saveEvent({ name: 'Fall Conference', coordinators: ['coord@example.org'] }).savedEventId;
  h.app.props_().setProperty('PEOPLE_LANG', JSON.stringify({ 'coord@example.org': 'es' }));

  h.as('coord@example.org');
  assert.equal(h.app.appLanguage_(), 'es');
  const boot = h.app.doGet({ parameter: { view: 'coordinator', e: eid } }).data;
  assert.equal(boot.lang, 'es');
  assert.equal(boot.words['coord.sorted'], 'Sorted', 'English until someone writes the Spanish');
  assert.equal(h.app.t_('coord.sorted', null, 'es'), 'Sorted');
  assert.equal(h.app.appLanguageCode_('fr'), 'en', 'a language we do not have is English');
  assert.throws(() => h.app.t_('coord.nothing'), /Unknown phrase/);

  // The room screen has nobody signed in, so it follows the session, then the event, then the site.
  h.as();
  const s = h.session({ name: 'Talk', access: 'link', active: true, eventId: eid });
  assert.equal(h.app.roomLanguage_(h.app.getSession_(s.id)), 'en');
  h.app.props_().setProperty('APP_LANGUAGE', 'es');
  assert.equal(h.app.roomLanguage_(h.app.getSession_(s.id)), 'es', 'the site\'s own language');
  assert.equal(h.app.appLanguage_('nobody@example.org'), 'es', 'and anyone with no choice of their own');
});
