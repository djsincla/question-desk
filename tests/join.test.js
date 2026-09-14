'use strict';
/** docs/join: the wrapper page that embeds guest pages so browsers send no Google sign-in. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JoinUrl = require('../docs/join/join-url');

const D = 'AKfycb' + 'x'.repeat(66);
const BASE = 'https://script.google.com/macros/s/' + D + '/exec?';

test('one wrapper page serves every session from its address', () => {
  assert.equal(JoinUrl.target('?d=' + D + '&view=present&s=2b338480&r=0123456789abcdef'), BASE + 'view=present&s=2b338480&r=0123456789abcdef');
  assert.equal(JoinUrl.target('?d=' + D + '&view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr'), BASE + 'view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr');
  assert.equal(JoinUrl.target('?d=' + D + '&s=2b338480&t=0123456789ab'), BASE + 's=2b338480&t=0123456789ab');
  assert.equal(JoinUrl.target('?d=' + D + '&s=2b338480&k=0123456789abcdef&lang=ko'), BASE + 's=2b338480&k=0123456789abcdef&lang=ko');
});

test('anything but a Question Desk guest page is refused', () => {
  [
    '', '?', '?s=2b338480&t=0123456789ab',                                  // no deployment
    '?d=' + D,                                                              // no session
    '?d=' + D + '&view=present&s=2b338480',                                 // room screen needs its key
    '?d=' + D + '&s=2b338480&k=0123456789abcdef&r=0123456789abcdef',        // key only on room screens
    '?d=evil.example&view=present&s=2b338480',
    '?d=' + D + '&view=moderate&s=2b338480',                                // staff page
    '?d=' + D + '&view=admin',
    '?d=' + D + '&s=2b338480',                                              // participant needs t or k
    '?d=' + D + '&s=2b338480&t=0123456789ab&k=0123456789abcdef',
    '?d=' + D + '&view=present&s=2b338480&t=0123456789ab',
    '?d=' + D + '&s=2b338480&t=0123456789ab&layout=qr',
    '?d=' + D + '&s=ZZZ&t=0123456789ab',
    '?d=' + D + '/../../evil&view=present&s=2b338480',
    '?d=' + D + '&view=present&s=2b338480"><script>'
  ].forEach((q) => assert.equal(JoinUrl.target(q), null, q));
});

test('the wrapper page only embeds what JoinUrl allows and sends no referrer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs/join/index.html'), 'utf8');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.deepEqual(Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]), ['join-url.js']);
  assert.match(html, /var url = JoinUrl\.target\(location\.search, /);
  assert.deepEqual(Array.from(html.matchAll(/setAttribute\('src', (\w+)\)/g), (m) => m[1]), ['url']);
  assert.doesNotMatch(html, /AKfycb/, 'no deployment id in the repository');
});

test('tracking tags, &amp; and #fragments added by apps and newsletters do not break a guest link', () => {
  const direct = 'https://script.google.com/macros/s/' + D + '/exec?s=2b338480&k=0123456789abcdef';
  [
    '?d=' + D + '&s=2b338480&k=0123456789abcdef&fbclid=IwAR0abc',
    '?utm_source=newsletter&d=' + D + '&s=2b338480&k=0123456789abcdef&utm_medium=email',
    '?d=' + D + '&amp;s=2b338480&amp;k=0123456789abcdef',
    '?d=' + D + '&s=2b338480&k=0123456789abcdef#section',
    '?d=' + D + '&s=2b338480&k=0123456789abcdef&next=https://evil.example'
  ].forEach((q) => assert.equal(JoinUrl.target(q), direct, q));
});

test('a self-hosted guest page can be locked to one Question Desk deployment', () => {
  const other = 'AKfycb' + 'y'.repeat(66);
  const q = '&s=2b338480&k=0123456789abcdef';
  assert.ok(JoinUrl.target('?d=' + D + q, D));
  assert.equal(JoinUrl.target('?d=' + other + q, D), null);
  assert.ok(JoinUrl.target('?d=' + other + q, ''), 'unlocked copies take any deployment');
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs/join/index.html'), 'utf8');
  assert.match(html, /<html lang="en" data-only-deployment="">/, 'the shared copy stays unlocked');
  assert.match(html, /JoinUrl\.target\(location\.search, document\.documentElement\.getAttribute\('data-only-deployment'\)\)/);
});

test('the guest page trusts exactly the same Google origins as the PowerPoint add-in', () => {
  // docs/join is copied to other sites on its own, so it can't load the add-in's room-url.js;
  // this keeps its copy of the check identical.
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs/join/index.html'), 'utf8');
  const addin = fs.readFileSync(path.join(__dirname, '..', 'docs/addin/room-url.js'), 'utf8');
  const guestRe = html.match(/if \(!(\/\^https:[^\n]*?\$\/)\.test\(e\.origin\)\)/);
  const addinRe = addin.match(/return (\/\^https:[^\n]*?\$\/)\.test\(String\(origin/);
  assert.ok(guestRe && addinRe, 'both checks found');
  assert.equal(guestRe[1], addinRe[1]);
});
