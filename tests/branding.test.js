'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

function fakePng(chars, fill) {
  const prefix = 'data:image/png;base64,';
  return prefix + (fill || 'A').repeat(chars - prefix.length);
}

test('the global logo is stored in the Assets sheet, split under the cell limit, and cached', () => {
  const h = createApp().install();
  const logo = fakePng(59000);
  h.app.saveLogo(logo);
  const row = h.assets().rows.find((r) => r[0] === 'global');
  assert.ok(row.length >= 3, 'split across at least two cells');
  assert.ok(row.slice(1).every((c) => c.length <= 50000));
  assert.equal(h.app.brand_(null).logo, logo);

  // Served from the cache: no sheet read needed on a participant page load.
  h.assets().rows = [h.assets().rows[0]];
  assert.equal(h.app.brand_(null).logo, logo);
});

test('replacing a logo leaves exactly one row; removing it clears row and cache', () => {
  const h = createApp().install();
  h.app.saveLogo(fakePng(59000));
  const small = fakePng(3000, 'B');
  h.app.saveLogo(small);
  assert.equal(h.assets().rows.filter((r) => r[0] === 'global').length, 1);
  assert.equal(h.app.brand_(null).logo, small);
  h.app.removeLogo();
  assert.equal(h.assets().rows.filter((r) => r[0] === 'global').length, 0);
  assert.equal(h.app.brand_(null).logo, '');
});

test('logo validation: type, encoding and size', () => {
  const h = createApp().install();
  assert.throws(() => h.app.saveLogo('data:image/svg+xml;base64,AAAA'), /PNG, JPEG or WebP/);
  assert.throws(() => h.app.saveLogo('data:text/html;base64,AAAA'), /PNG, JPEG or WebP/);
  assert.throws(() => h.app.saveLogo('data:image/png;base64,<script>'), /PNG, JPEG or WebP/);
  assert.throws(() => h.app.saveLogo('javascript:alert(1)'), /PNG, JPEG or WebP/);
  assert.throws(() => h.app.saveLogo(fakePng(60001)), /too large/);
});

test('brand settings are validated and trimmed', () => {
  const h = createApp().install();
  h.app.saveBrand({
    orgName: '  Example   Society  ', accent: '#FF8800', welcome: '  Welcome!  '.repeat(40),
    footer: 'example.org · (555) 555-0100', roomBgDark: '#000000', roomBgLight: 'white', faviconUrl: ''
  });
  const b = h.app.brand_(null);
  assert.equal(b.orgName, 'Example Society');
  assert.equal(b.accent, '#ff8800');
  assert.equal(b.welcome.length, 200);
  assert.equal(b.footer, 'example.org · (555) 555-0100');
  assert.equal(b.roomBgDark, '#000000');
  assert.equal(b.roomBgLight, '#ffffff', 'invalid color falls back to default');

  h.app.saveBrand({ orgName: 'x', accent: 'red; background:url(evil)' });
  assert.equal(h.app.brand_(null).accent, '#1b5e5a');
});

test('tab icon must be an https URL, and a rejected icon never breaks a page', () => {
  const h = createApp().install();
  assert.throws(() => h.app.saveBrand({ faviconUrl: 'http://example.org/icon.png' }), /https:\/\//);
  assert.throws(() => h.app.saveBrand({ faviconUrl: 'https://x.org/a.png" onload="x' }), /https:\/\//);
  h.app.saveBrand({ faviconUrl: 'https://example.org/icon.png' });
  assert.equal(h.app.doGet({ parameter: { view: 'admin' } }).favicon, 'https://example.org/icon.png');

  h.env.faviconError = 'Invalid argument: url';
  const page = h.app.doGet({ parameter: { view: 'admin' } });
  assert.equal(page.file, 'Admin.html');
  assert.ok(h.env.logs.some((l) => /Favicon: Error: Invalid argument/.test(l)));
});

test('branding reaches every page', () => {
  const h = createApp().install();
  h.app.saveBrand({ orgName: 'Example Society', accent: '#123456', welcome: 'Hi', footer: 'Foot' });
  h.app.saveLogo(fakePng(1000));
  const s = h.session({ name: 'Brand', active: true });
  const pages = [
    h.app.doGet({ parameter: { view: 'admin' } }),
    h.app.doGet({ parameter: { view: 'present', s: s.id } }),
    h.app.doGet({ parameter: { view: 'moderate', s: s.id } }),
    h.app.doGet({ parameter: {} }),
    h.anonymous().app.doGet({ parameter: { s: s.id } })
  ];
  pages.forEach((p) => {
    assert.equal(p.data.brand.orgName, 'Example Society', p.file);
    assert.equal(p.data.brand.accent, '#123456', p.file);
    assert.equal(p.data.brand.welcome, 'Hi', p.file);
    assert.equal(p.data.brand.footer, 'Foot', p.file);
    assert.equal(p.data.brand.logo.length, 1000, p.file);
  });
});

test('a session can override org name, accent and logo; other sessions keep the global brand', () => {
  const h = createApp().install({ moderators: ['mod@example.org'] });
  h.app.saveBrand({ orgName: 'Example Society', accent: '#123456' });
  h.app.saveLogo(fakePng(1000, 'G'));
  const partner = h.session({ name: 'Partner night', active: true, brandOrgName: 'Partner Org', brandAccent: '#AA0000', moderators: ['mod@example.org'] });
  const plain = h.session({ name: 'Regular', active: true });
  const partnerLogo = fakePng(2000, 'P');
  h.app.saveLogo(partnerLogo, partner.id);

  const p = h.anonymous().app.doGet({ parameter: { s: partner.id } }).data.brand;
  assert.deepEqual([p.orgName, p.accent, p.logo], ['Partner Org', '#aa0000', partnerLogo]);
  const g = h.app.doGet({ parameter: { s: plain.id } }).data.brand;
  assert.equal(g.orgName, 'Example Society');
  assert.equal(g.logo.charAt(30), 'G');

  h.as(h.env.owner);
  assert.equal(h.app.getSessionLogo(partner.id), partnerLogo);
  h.app.removeLogo(partner.id);
  assert.equal(h.anonymous().app.doGet({ parameter: { s: partner.id } }).data.brand.logo.charAt(30), 'G', 'falls back to global logo');
  h.as(h.env.owner);
  assert.throws(() => h.app.saveSession({ name: 'Bad', brandAccent: 'blue' }), /accent color must look like/);
});

test('session branding is used in that session\'s emails and room screen poll', () => {
  const h = createApp().install({ moderators: ['mod@example.org'] });
  h.app.saveBrand({ orgName: 'Example Society', footer: 'example.org' });
  const s = h.session({ name: 'Partner', access: 'link', active: true, brandOrgName: 'Partner Org', brandAccent: '#aa0000', moderators: ['mod@example.org'] });
  h.app.emailLinks(s.id, { to: 'guest@example.org', participant: true });
  const mail = h.env.outbox[0];
  assert.equal(mail.name, 'Partner Org');
  assert.match(mail.htmlBody, /#aa0000/);
  assert.match(mail.htmlBody, /example\.org/, 'global footer still applies');

  const screen = h.app.getRoomScreen(s.id);
  assert.equal(screen.brand.accent, '#aa0000');
  assert.equal(screen.brand.logo, undefined, 'poll stays small; logo comes with the page');
});

test('injected page data cannot break out of its script tag', () => {
  const h = createApp().install();
  h.app.saveBrand({ orgName: '</script><script>alert(1)</script>' + String.fromCharCode(0x2028) });
  h.app.saveSession({ name: '</script><img src=x onerror=alert(1)>' });
  const page = h.app.doGet({ parameter: { view: 'present' } });
  assert.doesNotMatch(page.boot, /</);
  assert.doesNotMatch(page.boot, new RegExp(String.fromCharCode(0x2028)));
  assert.equal(page.data.brand.orgName, '</script><script>alert(1)</script>');
  assert.equal(page.data.links[0].label, '</script><img src=x onerror=alert(1)>');
});

test('putting the guest page address in the Google address field is refused with a pointer, and nothing is half-saved', () => {
  const h = createApp().install();
  h.app.saveBrand({ orgName: 'Before', guestPageUrl: '' });
  assert.throws(() => h.app.saveBrand({ orgName: 'After', publicUrl: 'https://djsincla.github.io/question-desk/join', guestPageUrl: '' }),
    /looks like a guest page address\. Put it in "Guest page address"/);
  assert.equal(h.app.brand_(null).orgName, 'Before', 'branding was not saved');
  assert.throws(() => h.app.saveBrand({ publicUrl: 'https://script.google.com/a/example.org/macros/s/X/exec' }), /must look like https:\/\/script\.google\.com\/macros\/s/);
  assert.throws(() => h.app.saveBrand({ orgName: 'Again', guestPageUrl: 'http://insecure.example/' }), /guest page address must be an https/);
  assert.equal(h.app.brand_(null).orgName, 'Before');

  h.app.saveBrand({ orgName: 'After', publicUrl: '', guestPageUrl: 'https://djsincla.github.io/question-desk/join' });
  assert.equal(h.app.adminState().guestPageUrl, 'https://djsincla.github.io/question-desk/join/');
  assert.equal(h.app.brand_(null).orgName, 'After');
});
