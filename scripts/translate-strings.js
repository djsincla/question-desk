'use strict';
/**
 * Drafts the app's own words in another language, for a person to read before it ships.
 *
 *   GEMINI_API_KEY=… node scripts/translate-strings.js es
 *   (read translations/es.json, fix anything that reads wrong)
 *   node scripts/translate-strings.js es --apply
 *
 * Run by hand, never by CI and never by the app: the wording is reviewed and committed, so a
 * room never waits on a translation. --apply inserts each phrase into its own line in
 * server/strings.js, leaving the order and grouping of the catalog alone.
 *
 * Participant-facing text (UI_TEXT in server/text.js) is not this script's business: those
 * seven languages are what the audience reads, and they are already written.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../tests/harness');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'server', 'strings.js');
const OUT_DIR = path.join(ROOT, 'translations');
const BATCH = 40;

const app = createApp().app;
const TEXT = app.APP_TEXT;
const LANGUAGES = app.CONFIG.appLanguages;

/**
 * What Gemini is told. The do-not-soften rule is the same one the grouping and merge prompts
 * carry: a facilitator reads these screens to a room, and a translation that rounds off an
 * edge is a real failure, not a style choice.
 */
function prompt(rows, language) {
  return [
    'You are translating the interface of Question Desk, an anonymous audience question tool',
    'used by a nonprofit at community events. Translate each phrase into ' + language + '.',
    '',
    'Rules:',
    '1. Keep every {placeholder} exactly as it is, spelled the same. They are filled in with',
    '   names and counts at runtime. Do not add, remove or rename one.',
    '2. Keep the tone: plain, warm, short. These are read by staff running a live event, often',
    '   in a hurry. Prefer the wording a person would say out loud.',
    '3. Do not soften anything. Where the English is direct about a problem, stay direct.',
    '4. Leave these untranslated: Question Desk, Gemini, WordPress, PowerPoint, Google, CSV, QR.',
    '5. Keep any HTML tags and entities exactly as they appear.',
    '6. The key tells you where the phrase appears — admin.* is the Admin page, mod.* the',
    '   facilitator queue, coord.* the Event Coordinator portal, present.* and panel.* the room,',
    '   mail.* an email, err.* a message shown when something is refused.',
    '7. A phrase ending in .one is the singular form and .other the plural; translate each for',
    '   its own count, in the way ' + language + ' actually forms them.',
    '',
    'Answer with one JSON object per line: {"key": "…", "text": "…"}. Nothing else.',
    '',
    'Phrases:',
    rows.map(function (r) { return JSON.stringify({ key: r.key, english: r.en }); }).join('\n')
  ].join('\n');
}

async function ask(rows, language, key) {
  const body = {
    contents: [{ parts: [{ text: prompt(rows, language) }] }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          phrases: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { key: { type: 'STRING' }, text: { type: 'STRING' } },
              required: ['key', 'text']
            }
          }
        },
        required: ['phrases']
      } }
  };
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
    app.CONFIG.model + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Gemini ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const answer = await res.json();
  const text = answer.candidates[0].content.parts[0].text;
  return JSON.parse(text).phrases;
}

/** Placeholders must survive: a dropped {n} shows a sentence with a hole in it. */
function tokens(text) {
  return (String(text).match(/\{\w+\}/g) || []).sort().join(' ');
}

async function draft(code) {
  const language = LANGUAGES[code].name;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Set GEMINI_API_KEY to the key from aistudio.google.com.');

  const todo = Object.keys(TEXT).filter(function (k) { return !TEXT[k][code]; })
    .map(function (k) { return { key: k, en: TEXT[k].en }; });
  if (!todo.length) return console.log('Every phrase already has ' + language + '.');
  console.log(todo.length + ' phrases to draft in ' + language + '…');

  const drafted = {};
  const problems = [];
  for (let at = 0; at < todo.length; at += BATCH) {
    const rows = todo.slice(at, at + BATCH);
    const answers = await ask(rows, language, apiKey);
    answers.forEach(function (a) {
      if (!TEXT[a.key]) return problems.push(a.key + ': not a phrase');
      if (tokens(a.text) !== tokens(TEXT[a.key].en)) {
        return problems.push(a.key + ': placeholders changed — ' + JSON.stringify(a.text));
      }
      drafted[a.key] = a.text;
    });
    console.log('  ' + Math.min(at + BATCH, todo.length) + '/' + todo.length);
  }

  const missing = todo.filter(function (r) { return !drafted[r.key]; }).map(function (r) { return r.key; });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, code + '.json');
  fs.writeFileSync(file, JSON.stringify(drafted, null, 1) + '\n');
  console.log('\nWrote ' + Object.keys(drafted).length + ' phrases to ' + path.relative(ROOT, file));
  if (problems.length) console.log('Skipped ' + problems.length + ':\n  ' + problems.join('\n  '));
  if (missing.length) console.log('No answer for ' + missing.length + ': ' + missing.join(', '));
  console.log('\nRead it, fix anything that reads wrong, then: node scripts/translate-strings.js ' + code + ' --apply');
}

/**
 * Puts the reviewed wording into the catalog, one line at a time, so the file keeps its order
 * and its grouping. A phrase that already has this language is left alone.
 */
function apply(code) {
  const file = path.join(OUT_DIR, code + '.json');
  if (!fs.existsSync(file)) throw new Error('No ' + path.relative(ROOT, file) + ' yet. Draft it first.');
  const drafted = JSON.parse(fs.readFileSync(file, 'utf8'));
  const quoted = function (s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; };

  let added = 0;
  const lines = fs.readFileSync(CATALOG, 'utf8').split('\n').map(function (line) {
    const m = /^(\s*)'([^']+)': \{ en: ((?:[^'\\]|\\.|')*?) \},$/.exec(line);
    if (!m) return line;
    const key = m[2];
    if (!drafted[key] || TEXT[key][code]) return line;
    added++;
    return m[1] + "'" + key + "': { en: " + m[3] + ', ' + code + ': ' + quoted(drafted[key]) + ' },';
  });
  fs.writeFileSync(CATALOG, lines.join('\n'));
  console.log('Put ' + added + ' ' + LANGUAGES[code].name + ' phrases into server/strings.js.');
  console.log('Now: npm test && npm run wp:build');
}

const code = process.argv[2];
if (!code || !LANGUAGES[code]) {
  console.error('Usage: node scripts/translate-strings.js <' + Object.keys(LANGUAGES).join('|') + '> [--apply]');
  process.exit(1);
}
const run = process.argv.indexOf('--apply') !== -1 ? Promise.resolve(apply(code)) : draft(code);
Promise.resolve(run).catch(function (err) { console.error(String(err.message || err)); process.exit(1); });
