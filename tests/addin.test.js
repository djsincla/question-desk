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
    'https://script.google.com/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d',
    'https://script.google.com/a/macros/example.org/s/AbC_12-x/exec?view=present&s=1a2b3c4d',
    'https://script.google.com/a/example.org/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d',
    '  https://script.google.com/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d&layout=qr  ',
    'https://script.google.com/macros/s/AbC_12-x/exec?view=moderate&s=1a2b3c4d',
    'https://script.google.com/macros/s/AbC_12-x/exec?s=1a2b3c4d&k=0123456789abcdef',
    'https://script.google.com/macros/s/AbC_12-x/exec?view=present&amp;s=1a2b3c4d',   // pasted from Outlook/Teams
    'https://script.google.com/macros/s/AbC_12-x/exec?view=present&s=1a2b3c4d#top'
  ];
  forms.forEach((link) => {
    assert.equal(RoomUrl.forSlide(link), PUBLIC + '?view=present&s=1a2b3c4d&layout=qr', link);
    assert.equal(RoomUrl.forSlide(link, true), PUBLIC + '?view=present&s=1a2b3c4d', link);
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
    'https://script.google.com/macros/s/AbC/exec?s=1a2b3c4d"><script>'
  ].forEach((link) => assert.equal(RoomUrl.forSlide(link), null, link));
});

test('the room screen offers a QR-only layout, and the admin gets a slide link', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Slide', active: true });
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id, layout: 'qr' } }).data.layout, 'qr');
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id } }).data.layout, 'full');
  assert.equal(h.app.doGet({ parameter: { view: 'present', s: s.id, layout: '<x>' } }).data.layout, 'full');
  h.as(h.env.owner);
  const slide = h.app.adminState().sessions[0].links.slide;
  assert.equal(slide, 'https://script.google.com/macros/s/DEPLOYID/exec?view=present&s=' + s.id + '&layout=qr');
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
  const srcSets = Array.from(page.matchAll(/setAttribute\('src', (\w+)\)/g), (m) => m[1]);
  assert.deepEqual(srcSets, ['url']);
  assert.match(page, /var url = RoomUrl\.forSlide\(saved\.link, saved\.full\);/);
  assert.doesNotMatch(page, /innerHTML/);
  const inline = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(inline));
});
