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
  assert.match(html, /var url = JoinUrl\.target\(location\.search, root\.getAttribute\('data-only-deployment'\), root\.getAttribute\('data-site'\)\)/);
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
  assert.match(html, /<html lang="en" data-only-deployment="" data-site="">/, 'the shared copy stays unlocked');
});

test('a guest page hosted for a WordPress Question Desk names the site itself', () => {
  const SITE = 'https://autismla.example/questions/';
  // The same links the WordPress version makes, with no deployment of their own.
  assert.equal(JoinUrl.target('?s=2b338480&t=0123456789ab', '', SITE), SITE + '?s=2b338480&t=0123456789ab');
  assert.equal(JoinUrl.target('?s=2b338480&k=0123456789abcdef&lang=ko', '', SITE), SITE + '?s=2b338480&k=0123456789abcdef&lang=ko');
  assert.equal(JoinUrl.target('?view=present&s=2b338480&r=0123456789abcdef&layout=qr', '', SITE),
    SITE + '?view=present&s=2b338480&r=0123456789abcdef&layout=qr');
  assert.equal(JoinUrl.target('?view=panel&s=2b338480&r=0123456789abcdef', '', SITE), SITE + '?view=panel&s=2b338480&r=0123456789abcdef');
  // Addresses are tidied the same way the plugin tidies them, so both agree on the link.
  assert.equal(JoinUrl.target('?s=2b338480&t=0123456789ab', '', 'https://autismla.example/questions'), SITE + '?s=2b338480&t=0123456789ab');
  assert.equal(JoinUrl.target('?s=2b338480&t=0123456789ab', '', 'https://autismla.example/join/index.html'),
    'https://autismla.example/join/index.html?s=2b338480&t=0123456789ab');

  // The same checks as ever apply to the parameters.
  ['?s=2b338480', '?view=present&s=2b338480', '?view=moderate&s=2b338480&r=0123456789abcdef',
    '?s=ZZZ&t=0123456789ab', '?s=2b338480&t=0123456789ab&k=0123456789abcdef'
  ].forEach((q) => assert.equal(JoinUrl.target(q, '', SITE), null, q));
});

test('a link can never name the site itself: only the hosted copy decides what is framed', () => {
  // Without data-site there is nothing to frame, however the link is dressed up.
  [
    '?s=2b338480&t=0123456789ab',
    '?site=https://evil.example&s=2b338480&t=0123456789ab',
    '?d=https://evil.example&s=2b338480&t=0123456789ab',
    '?data-site=https://evil.example&s=2b338480&t=0123456789ab'
  ].forEach((q) => assert.equal(JoinUrl.target(q, '', ''), null, q));
  // With one, the framed address is built from that site and the checked parameters only.
  const framed = JoinUrl.target('?site=https://evil.example&s=2b338480&t=0123456789ab', '', 'https://autismla.example/questions/');
  assert.equal(framed, 'https://autismla.example/questions/?s=2b338480&t=0123456789ab');
  // Nothing but https, and nothing carrying its own query or fragment, can be a site.
  ['http://autismla.example/', 'javascript:alert(1)', '//autismla.example/', 'https://autismla.example/?x=1',
    'https://autismla.example/#x', 'https://' + 'a'.repeat(400) + '.example/'
  ].forEach((site) => assert.equal(JoinUrl.cleanSite(site), '', site));
});

test('the guest page trusts exactly the same Google origins as the PowerPoint add-in', () => {
  // docs/join is copied to other sites on its own, so it can't load the add-in's room-url.js;
  // this keeps its copy of the check identical.
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs/join/index.html'), 'utf8');
  const addin = fs.readFileSync(path.join(__dirname, '..', 'docs/addin/room-url.js'), 'utf8');
  const guestRe = html.match(/var google = (\/\^https:[^\n]*?\$\/)\.test\(e\.origin\)/);
  const addinRe = addin.match(/return (\/\^https:[^\n]*?\$\/)\.test\(String\(origin/);
  assert.ok(guestRe && addinRe, 'both checks found');
  assert.equal(guestRe[1], addinRe[1]);
  // A framed WordPress screen reports from its own site, which is the one being shown.
  assert.match(html, /if \(!google && e\.origin !== fromScreen\) return;/);
  assert.equal(JoinUrl.origin('https://autismla.example/questions/?view=present'), 'https://autismla.example');
  assert.equal(JoinUrl.origin('not a url'), '');
});

test('a guest page inside the PowerPoint add-in passes the screen’s reports on', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs/join/index.html'), 'utf8');
  // Nested, it relays rather than reloading: the add-in reloads, and can only check the origin
  // it framed, which is the guest page's own.
  assert.match(html, /var nested = window\.top !== window;/);
  assert.match(html, /window\.top\.postMessage\(\{ questionDesk: e\.data\.questionDesk/);
  assert.match(html, /if \(nested\) return;/, 'the silence watchdog is the top page’s job');

  // And the screen tells its guest page as well as the top, so the relay has something to pass.
  const scripts = fs.readFileSync(path.join(__dirname, '..', 'Scripts.html'), 'utf8');
  assert.match(scripts, /if \(window\.parent !== window\.top\) window\.parent\.postMessage\(message, '\*'\);/);
});
