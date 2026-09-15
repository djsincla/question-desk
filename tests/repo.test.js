'use strict';
/** Repository hygiene: versioning, release notes, and the secret scanner. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./harness');
const secrets = require('../scripts/check-secrets');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('admin page gets the app version and a release notes link', () => {
  const h = createApp().install();
  const app = h.app.adminState().app;
  assert.match(app.version, /^\d+\.\d+\.\d+$/);
  assert.equal(app.releaseNotes, 'https://github.com/djsincla/question-desk/releases/tag/v' + app.version);
});

test('CHANGELOG.md has a dated section and link for the current version', () => {
  const version = createApp().app.APP.version;
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, new RegExp('^## \\[' + version.replace(/\./g, '\\.') + '\\] - \\d{4}-\\d{2}-\\d{2}$', 'm'));
  assert.match(changelog, new RegExp('^\\[' + version.replace(/\./g, '\\.') + '\\]: https://github\\.com/djsincla/question-desk/releases/tag/v' + version.replace(/\./g, '\\.') + '$', 'm'));
  const top = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)[1];
  assert.equal(top, version, 'newest changelog entry matches APP.version');
});

test('ship.sh reads the same version the app reports', () => {
  const ship = read('scripts/ship.sh');
  const pattern = ship.match(/sed -n "s\/\^  version: '\\\(\[0-9\]\[0-9\.\]\*\\\)',\$\/\\1\/p" Code\.js/);
  assert.ok(pattern, 'ship.sh parses APP.version from Code.js');
  assert.match(read('Code.js'), /^  version: '\d+\.\d+\.\d+',$/m);
});

test('secret scanner catches keys, tokens, deployment IDs and real emails', () => {
  const samples = [
    ['AI' + 'za' + 'Sy' + 'A'.repeat(33), 'Google API key'],
    ['gh' + 'p_' + 'a'.repeat(36), 'GitHub token'],
    ['AKfy' + 'cbw' + 'X'.repeat(40), 'Apps Script deployment ID'],
    ['"script' + 'Id": "1abc_real_id"', 'Apps Script project ID'],
    ['-----BEGIN ' + 'PRIVATE KEY-----', 'Private key'],
    ['someone' + '@' + 'realcompany.com', 'Email address'],
    ['someone' + '@' + 'anthropic.com', 'Email address'],
    ['boss' + '@' + 'domain.org', 'Email address'],
    ['https://script.google.com/' + 'd/' + '1AbCdEfGhIjKlMnOpQrStUvWxYz0123/edit', 'Apps Script project ID'],
    ['GOC' + 'SPX-' + 'a'.repeat(28), 'OAuth client secret']
  ];
  samples.forEach(([text, name]) => {
    const found = secrets.scanText('x ' + text + ' y', 'sample');
    assert.ok(found.some((f) => f.name === name), name + ' not detected');
  });
});

test('secret scanner allows placeholders', () => {
  const ok = 'mod@example.org owner@example.com a@b.test name@domain.org noreply@anthropic.com ' +
    '1+x@users.noreply.github.com "scriptId": "YOUR_SCRIPT_ID"';
  assert.deepEqual(secrets.scanText(ok, 'sample'), []);
});

test('secret scanner reports a file it cannot read instead of skipping it', () => {
  const findings = secrets.scanFiles(['notés.md'], () => { throw new Error('ENOENT'); });
  assert.equal(findings.length, 1);
  assert.match(findings[0].name, /Could not read/);
});

test('local config files can never be committed', () => {
  const findings = secrets.scanFiles(['.clasp.json', '.deploy.env', '.env.local', 'key.pem', 'README.md'], () => 'clean');
  assert.deepEqual(findings.map((f) => f.where), ['.clasp.json', '.deploy.env', '.env.local', 'key.pem']);
  const ignore = read('.gitignore');
  ['.clasp.json', '.clasprc.json', '.deploy.env', '.env'].forEach((f) => assert.match(ignore, new RegExp('^' + f.replace('.', '\\.') + '$', 'm')));
});

test('every tracked-to-be file is clean', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach((d) => {
      const rel = dir ? dir + '/' + d.name : d.name;
      // Downloaded dependencies (npm, Composer) are ignored by git and never committed.
      if (d.isDirectory()) { if (['.git', 'node_modules', 'vendor'].indexOf(d.name) === -1) walk(rel); return; }
      files.push(rel);
    });
  })('');
  const ignored = /(^|\/)(\.clasp\.json|\.clasprc\.json|\.deploy\.env|\.DS_Store|composer\.lock)$/;
  const findings = secrets.scanFiles(files.filter((f) => !ignored.test(f)), (f) => read(f));
  assert.deepEqual(findings, []);
});

test('the GitHub Pages splash page links the donation page and never the app itself', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs/index.html'), 'utf8');
  assert.match(html, /<a class="button" href="https:\/\/www\.autismla\.org\/1\/donate\/"[^>]*>Donate<\/a>/);
  assert.doesNotMatch(html, /script\.google(usercontent)?\.com|AKfycb/, 'no app address in the public repo');
  assert.doesNotMatch(html, /<script|<link|<img|@import|url\(/, 'self-contained: nothing loaded from elsewhere');
  assert.match(html, /<meta name="viewport"/);
});

test('package authors\' addresses in package-lock.json are allowed, but nothing else is', () => {
  const author = '"author": "maintainer' + '@' + 'package-author.invalid"';   // built at runtime, so this file stays clean
  assert.deepEqual(secrets.scanText(author, 'package-lock.json'), []);
  assert.equal(secrets.scanText(author, 'package.json').length, 1, 'only the lock file');
  assert.equal(secrets.scanText('key AIza' + 'x'.repeat(35), 'package-lock.json').length, 1, 'keys are still refused');
});
