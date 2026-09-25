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
/** What a browser shows for a piece of markup: entities resolved, spacing normalized. */
const shown = (text) => text
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();
const SOURCE = read('server/strings.js');
const PAGES = ['Admin.html', 'Coordinator.html', 'Home.html', 'Moderate.html', 'Panel.html', 'Present.html', 'Sheet.html'];
// Everything that asks for a phrase — not the catalog itself, whose keys are the definitions.
// The plugin reads the same catalog (data/app.json), so what it asks for counts as used.
const PLUGIN = 'wordpress/question-desk/includes';
const FILES = PAGES
  .concat(['Scripts.html'], SERVER_FILES.filter((f) => f !== 'server/strings.js'))
  .concat(fs.readdirSync(path.join(ROOT, PLUGIN)).filter((f) => f.endsWith('.php')).map((f) => PLUGIN + '/' + f));
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
    text.replace(/data-w(?:-ph|-t|-a)?="([^"]+)"/g, (whole, key) => named.push(key));
    text.replace(/\b(?:W|Wn|t_|tn_)\(\s*'([^']+)'/g, (whole, key) => named.push(key));
    text.replace(/QD_App::tn?\(\s*'([^']+)'/g, (whole, key) => named.push(key));
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
    read(file).replace(/data-w(?:-ph|-t|-a)?="([^"]+)"/g, (whole, key) => mentioned.push(key));
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
    assert.doesNotMatch(read(file), /\b(?:W|t_)\(\s*'[^']+\.(one|other)'/, file + ' asks for one plural form: use Wn() or tn_()');
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
  FILES.forEach((file) => assert.doesNotMatch(read(file), /\b(?:W|Wn|t_|tn_)\(\s*[^,)\n]*\+/,
    file + ' builds a phrase key out of pieces: write the key out in full'));
});

test('the markup keeps the English, so an English page substitutes nothing', () => {
  PAGES.forEach((file) => {
    const html = read(file);
    html.replace(/<(\w+)[^>]*\sdata-w="([^"]+)"[^>]*>([^<]*)</g, (whole, tag, key, text) => {
      if (!TEXT[key]) return '';
      assert.equal(shown(text), shown(TEXT[key].en),
        file + ': the markup under ' + key + ' says something the catalog does not');
      return '';
    });
    [['data-w-ph', 'placeholder'], ['data-w-t', 'title'], ['data-w-a', 'aria-label']].forEach((pair) => {
      const re = new RegExp('<\\w+[^>]*\\s' + pair[0] + '="([^"]+)"[^>]*>', 'g');
      html.replace(re, (whole, key) => {
        const said = new RegExp('\\s' + pair[1] + '="([^"]*)"').exec(whole);
        if (TEXT[key] && said) assert.equal(shown(said[1]), shown(TEXT[key].en), whole.slice(0, 60) + ' does not match ' + key);
        return '';
      });
    });
  });
});

test('what must stay English is not in the catalog', () => {
  const values = Object.keys(TEXT).map((key) => TEXT[key].en);
  // A language name is matched against Gemini's answer and against moderatorLanguage; the default
  // heading and the two room-screen messages Present.html recognises are compared as values too.
  // A screen may of course say the same words — what must never happen is the value coming from
  // the catalog, which is what the file checks below enforce.
  const keep = Object.keys(app.CONFIG.languages).map((c) => app.CONFIG.languages[c].name)
    .concat(['Questions for the panel'])
    .concat(['Session not found.', 'This room screen link is out of date. Copy the new one from the Admin page.']);
  keep.forEach((word) => {
    assert.ok(values.indexOf(word) === -1,
      '"' + word + '" is compared as a value somewhere; translating it breaks the app, so it must ' +
      'not be a phrase');
  });

  // Things written once and read back later — a sheet header, an exported column, a log entry —
  // never take their words from the catalog, however much a screen elsewhere says the same
  // English. Messages thrown along the way are ordinary phrases and may.
  assert.doesNotMatch(read('server/csv.js').split('const SESSION_CSV')[1].split('];')[0], /t_\(/,
    'the CSV columns are matched again on import, so they stay in one language');
  assert.doesNotMatch(read('server/activity.js'), /\bt_\(/,
    'the activity log is a record: what it stores stays in one language');
  assert.doesNotMatch(read('Code.js').split('const HEADERS')[1].split(';')[0], /t_\(/, 'sheet headers stay English');
  SERVER_FILES.forEach((file) => {
    assert.doesNotMatch(read(file), /audit_\(\s*(?:t_|W)\(/, file + ' logs a translated action name');
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
  assert.equal(boot.words['admin.copy'], undefined, 'and nothing the portal never shows');
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
  // A phrase nobody has drafted yet reads in English rather than not at all.
  const undrafted = Object.keys(h.app.APP_TEXT).filter((k) => !h.app.APP_TEXT[k].es)[0];
  if (undrafted) assert.equal(h.app.t_(undrafted, null, 'es'), h.app.APP_TEXT[undrafted].en);

  // The portal is sent its own words and the shared ones, not the Admin page's five hundred.
  assert.deepEqual(Object.keys(boot.words).map((k) => k.split('.')[0]).filter((p, i, all) => all.indexOf(p) === i).sort(),
    ['coord', 'shared']);
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

test('an administrator sets who reads the app in which language', () => {
  const h = createApp().install();
  h.app.addPerson('moderator', 'luis@example.org');
  assert.deepEqual(h.app.adminState().personLanguages, {});
  assert.deepEqual(h.app.adminState().appLanguages.map((l) => l.code), ['en', 'es']);

  h.app.setPersonLanguage('luis@example.org', 'es');
  assert.deepEqual(h.app.adminState().personLanguages, { 'luis@example.org': 'es' });
  assert.equal(h.app.appLanguage_('luis@example.org'), 'es');
  assert.equal(h.app.appLanguage_('nobody@example.org'), 'en', 'everyone else is unchanged');
  assert.ok(h.app.getActivity().entries.some((e) => e.action === 'Person language set'));

  // English is the default, so choosing it stores nothing at all.
  h.app.setPersonLanguage('luis@example.org', 'en');
  assert.deepEqual(h.app.adminState().personLanguages, {});
  assert.throws(() => h.app.setPersonLanguage('luis@example.org', 'fr'), /Not an app language: fr/);

  h.app.setPersonLanguage('luis@example.org', 'es');
  h.app.removePerson('moderator', 'luis@example.org');
  assert.deepEqual(h.app.adminState().personLanguages, {}, 'and it goes when they do');

  h.as('luis@example.org');
  assert.throws(() => h.app.setPersonLanguage('luis@example.org', 'es'), /Only administrators/);
});

test('a room reads the language its session, its event or the site chose', () => {
  const h = createApp().install();
  const eid = h.app.saveEvent({ name: 'Fall Conference', roomLanguage: 'es' }).savedEventId;
  const inEvent = h.session({ name: 'Keynote', access: 'link', active: true, eventId: eid });
  const own = h.session({ name: 'Workshop', access: 'link', active: true, eventId: eid, roomLanguage: 'en' });
  const plain = h.session({ name: 'Alone', access: 'link', active: true });

  assert.equal(h.app.roomLanguage_(h.app.getSession_(inEvent.id)), 'es', 'from its event');
  assert.equal(h.app.roomLanguage_(h.app.getSession_(own.id)), 'en', 'its own wins');
  assert.equal(h.app.roomLanguage_(h.app.getSession_(plain.id)), 'en');

  h.app.saveSiteLanguage('es');
  assert.equal(h.app.adminState().siteLanguage, 'es');
  assert.equal(h.app.roomLanguage_(h.app.getSession_(plain.id)), 'es');

  assert.throws(() => h.app.saveSiteLanguage('fr'), /Not an app language: fr/);

  // The room screen is handed that language, with nobody signed in at the venue laptop.
  const key = h.screenKey(plain);
  h.anonymous();
  const boot = h.app.doGet({ parameter: { view: 'present', s: plain.id, r: key } }).data;
  assert.equal(boot.lang, 'es');
  assert.ok(boot.words['present.paused'], 'and the footer it reads');
});
