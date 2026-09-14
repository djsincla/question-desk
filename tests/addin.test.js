'use strict';
/** The PowerPoint add-in (docs/addin) and the QR-only room screen it shows. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./harness');
const RoomUrl = require('../docs/addin/room-url');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PUBLIC = 'https://script.google.com/macros/s/AbC_12-x/exec';

test('any form of a session link becomes the public, QR-only slide address', () => {
  const forms = [
    'https://script.google.com/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d&r=0123456789abcdef',
    'https://script.google.com/a/macros/example.org/s/AbC_12-x/exec?view=present&s=1a2b3c4d&r=0123456789abcdef',
    'https://script.google.com/a/example.org/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d&r=0123456789abcdef',
    '  https://script.google.com/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr  ',
    'https://script.google.com/macros/s/AbC_12-x/exec?view=present&amp;s=1a2b3c4d&amp;r=0123456789abcdef',   // pasted from Outlook/Teams
    'https://script.google.com/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d&r=0123456789abcdef#top'
  ];
  forms.forEach((link) => {
    assert.equal(RoomUrl.forSlide(link), PUBLIC + '?view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr', link);
    // Always QR only: the full room screen was cramped and hard to read in a slide's box.
    assert.equal(RoomUrl.forSlide(link, true), PUBLIC + '?view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr', link);
    assert.equal(RoomUrl.direct(link), RoomUrl.forSlide(link), link);
  });
});

test('anything that is not a Question Desk session link is refused', () => {
  [
    '', 'hello', 'javascript:alert(1)',
    'http://script.google.com/macros/s/AbC/exec?s=1a2b3c4d',
    'https://evil.example/macros/s/AbC/exec?s=1a2b3c4d',
    'https://script.google.com.evil.example/macros/s/AbC/exec?s=1a2b3c4d',
    'https://script.google.com/macros/s/AbC/exec?view=present',
    'https://script.google.com/macros/s/AbC/exec?s=XYZ',
    'https://script.google.com/macros/s/AbC/exec?s=1a2b3c4d"><script>',
    // Without the room screen key: a participant or queue link can't become a room screen.
    'https://script.google.com/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d',
    'https://script.google.com/macros/s/AbC_12-x/exec?s=1a2b3c4d&k=0123456789abcdef',
    'https://script.google.com/macros/s/AbC_12-x/exec?view=moderate&s=1a2b3c4d'
  ].forEach((link) => assert.equal(RoomUrl.forSlide(link), null, link));
});

test('the room screen offers a QR-only layout, and the admin gets a slide link', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Slide', active: true });
  const r = h.screenKey(s);
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id, r, layout: 'qr' } }).data.layout, 'qr');
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id, r } }).data.layout, 'full');
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id, r, layout: '<x>' } }).data.layout, 'full');
  h.as(h.env.owner);
  const slide = h.app.adminState().sessions[0].links.slide;
  assert.equal(slide, 'https://script.google.com/macros/s/DEPLOYID/exec?view=present&s=' + s.id + '&r=' + r + '&layout=qr');
  assert.equal(RoomUrl.forSlide(slide), slide, 'the add-in accepts it unchanged');
});

test('manifest is a PowerPoint content add-in served from GitHub Pages, versioned with the app', () => {
  const manifest = read('docs/addin/manifest.xml');
  const version = createApp().app.APP.version;
  assert.match(manifest, /xsi:type="ContentApp"/);
  assert.match(manifest, /<Host Name="Presentation" \/>/);
  assert.match(manifest, /<Id>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/Id>/);
  assert.match(manifest, new RegExp('<Version>' + version.replace(/\./g, '\\.') + '\\.0</Version>'));
  const urls = Array.from(manifest.matchAll(/DefaultValue="(https:[^"]+)"/g), (m) => m[1]);
  urls.filter((u) => u.indexOf('github.io') !== -1).forEach((u) => {
    assert.match(u, /^https:\/\/djsincla\.github\.io\/question-desk\/addin\//);
    const file = path.join(ROOT, 'docs', u.replace('https://djsincla.github.io/question-desk/', ''));
    assert.ok(fs.existsSync(file), 'manifest points at a missing file: ' + u);
  });
  // Element order matters to Office's schema validator.
  const order = ['Id', 'Version', 'ProviderName', 'DefaultLocale', 'DisplayName', 'Description', 'IconUrl',
    'HighResolutionIconUrl', 'SupportUrl', 'AppDomains', 'Hosts', 'DefaultSettings', 'Permissions', 'AllowSnapshot'];
  const positions = order.map((tag) => manifest.indexOf('<' + tag));
  positions.forEach((p, i) => assert.ok(p > 0 && (i === 0 || p > positions[i - 1]), order[i] + ' out of order'));
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/.nojekyll')));
  assert.match(manifest, /<RequestedWidth>960<\/RequestedWidth>\s*<RequestedHeight>540<\/RequestedHeight>/, 'fills a 16:9 slide');
});

test('the add-in page only ever frames an address produced by RoomUrl', () => {
  const page = read('docs/addin/index.html');
  const scripts = Array.from(page.matchAll(/<script src="([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(scripts, ['https://appsforoffice.microsoft.com/lib/1/hosted/office.js', 'room-url.js']);
  const srcSets = Array.from(page.matchAll(/setAttribute\('src', ([\w.]+)\)/g), (m) => m[1]);
  assert.deepEqual(srcSets, ['url']);
  // frameUrl(url) is the only place a frame gets an address; every caller passes a RoomUrl result.
  const framed = Array.from(page.matchAll(/frameUrl\(([\w.]+)\)/g), (m) => m[1]);
  assert.deepEqual([...new Set(framed)].sort(), ['fallback', 'shown.url', 'url']);
  assert.match(page, /var url = RoomUrl\.forSlide\(saved\.link\);/);
  assert.match(page, /var direct = RoomUrl\.direct\(saved\.link\);/);
  assert.match(page, /shown\.fallback = url !== direct \? direct : '';/);
  assert.match(page, /var fallback = shown\.fallback;/);
  assert.match(page, /if \(!RoomUrl\.fromGoogle\(e\.origin\)/, 'only Google pages can make the add-in reload');
  assert.doesNotMatch(page, /innerHTML/);
  const inline = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(inline));
});

test('a guest page slide link stays on its guest page, for presenting laptops signed into Google', () => {
  const guest = 'https://djsincla.github.io/question-desk/join/?d=AKfycb' + 'x'.repeat(40) + '&view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr';
  assert.equal(RoomUrl.forSlide(guest), guest);
  assert.equal(RoomUrl.direct(guest), 'https://script.google.com/macros/s/AKfycb' + 'x'.repeat(40) + '/exec?view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr',
    'the fallback when the guest page will not load in PowerPoint');
  const own = 'https://autismla.example/questions/?d=AKfycb' + 'x'.repeat(40) + '&view=present&s=1a2b3c4d&r=0123456789abcdef';
  assert.equal(RoomUrl.forSlide(own), own + '&layout=qr');
  // Not a guest page link: refused.
  assert.equal(RoomUrl.forSlide('https://evil.example/"x"?d=AKfycb' + 'x'.repeat(40) + '&s=1a2b3c4d&r=0123456789abcdef'), null);
  assert.equal(RoomUrl.forSlide('http://insecure.example/join/?d=AKfycb' + 'x'.repeat(40) + '&s=1a2b3c4d&r=0123456789abcdef'), null);
});

test('custom guest page addresses the add-in accepts, in any parameter order', () => {
  const D = 'AKfycb' + 'x'.repeat(40);
  const tail = 'view=present&s=1a2b3c4d&r=0123456789abcdef&layout=qr';
  [
    'https://www.autismla.example/qa/',
    'https://autismla.example/question-desk/join/index.html',
    'https://autismla.example/qa',
    'https://events.autismla.example:8443/ask/',
    'https://autismla.example/join-us_2026/~page%20one/'
  ].forEach((base) => {
    assert.equal(RoomUrl.forSlide(base + '?d=' + D + '&' + tail), base + '?d=' + D + '&' + tail, base);
    // Room screen link (no layout), parameters reordered, pasted from Outlook, with tracking junk.
    const messy = base + '?s=1a2b3c4d&amp;utm_source=newsletter&amp;r=0123456789abcdef&amp;view=present&amp;d=' + D + '#section';
    assert.equal(RoomUrl.forSlide(messy), base + '?d=' + D + '&' + tail, messy);
    assert.equal(RoomUrl.direct(messy), 'https://script.google.com/macros/s/' + D + '/exec?' + tail);
  });
  // A guest page link is only as good as its parts.
  assert.equal(RoomUrl.forSlide('https://autismla.example/qa/?d=' + D + '&view=present&s=1a2b3c4d'), null, 'no room screen key');
  assert.equal(RoomUrl.forSlide('https://autismla.example/qa/?d=nope&view=present&s=1a2b3c4d&r=0123456789abcdef'), null, 'bad deployment');
  assert.equal(RoomUrl.forSlide('https://autismla.example/q a/?d=' + D + '&' + tail), null, 'space in the address');
});

test('only Google-served Question Desk pages can make the add-in reload', () => {
  assert.equal(RoomUrl.fromGoogle('https://n-abc123def-0lu-script.googleusercontent.com'), true);
  assert.equal(RoomUrl.fromGoogle('https://script.google.com'), true);
  ['https://evil.example', 'https://script.google.com.evil.example', 'https://x.googleusercontent.com.evil.example',
    'http://script.google.com', 'null', '', undefined].forEach((origin) => assert.equal(RoomUrl.fromGoogle(origin), false, String(origin)));
});

test('room screens and panelist views know their version, so a frame can reload an outdated one', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Versions', access: 'room', active: true });
  const r = h.screenKey(s);
  const version = h.app.APP.version;
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id, r, layout: 'qr' } }).data.version, version);
  assert.equal(h.app.doGet({ parameter: { view: 'panel', s: s.id, r } }).data.version, version);
  h.anonymous();
  assert.equal(h.app.getRoomScreen(s.id, 'qr', r).version, version);
});
