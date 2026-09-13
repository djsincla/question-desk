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
  assert.equal(JoinUrl.target('?d=' + D + '&view=present&s=2b338480'), BASE + 'view=present&s=2b338480');
  assert.equal(JoinUrl.target('?d=' + D + '&view=present&s=1a2b3c4d&layout=qr'), BASE + 'view=present&s=1a2b3c4d&layout=qr');
  assert.equal(JoinUrl.target('?d=' + D + '&s=2b338480&t=0123456789ab'), BASE + 's=2b338480&t=0123456789ab');
  assert.equal(JoinUrl.target('?d=' + D + '&s=2b338480&k=0123456789abcdef&lang=ko'), BASE + 's=2b338480&k=0123456789abcdef&lang=ko');
});

test('anything but a Question Desk guest page is refused', () => {
  [
    '', '?', '?s=2b338480&t=0123456789ab',                                  // no deployment
    '?d=' + D,                                                              // no session
    '?d=evil.example&view=present&s=2b338480',
    '?d=' + D + '&view=moderate&s=2b338480',                                // staff page
    '?d=' + D + '&view=admin',
    '?d=' + D + '&s=2b338480',                                              // participant needs t or k
    '?d=' + D + '&s=2b338480&t=0123456789ab&k=0123456789abcdef',
    '?d=' + D + '&view=present&s=2b338480&t=0123456789ab',
    '?d=' + D + '&s=2b338480&t=0123456789ab&layout=qr',
    '?d=' + D + '&s=ZZZ&t=0123456789ab',
    '?d=' + D + '&s=2b338480&t=0123456789ab&next=https://evil.example',    // unknown parameter
    '?d=' + D + '/../../evil&view=present&s=2b338480',
    '?d=' + D + '&view=present&s=2b338480"><script>'
  ].forEach((q) => assert.equal(JoinUrl.target(q), null, q));
});

test('the wrapper page only embeds what JoinUrl allows and sends no referrer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs/join/index.html'), 'utf8');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.deepEqual(Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]), ['join-url.js']);
  assert.match(html, /var url = JoinUrl\.target\(location\.search\);/);
  assert.deepEqual(Array.from(html.matchAll(/setAttribute\('src', (\w+)\)/g), (m) => m[1]), ['url']);
  assert.doesNotMatch(html, /AKfycb/, 'no deployment id in the repository');
});
