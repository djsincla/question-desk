'use strict';
/**
 * Visual comparisons: key pages are screenshotted from fixed demo data and compared with
 * saved baselines, so an unintended visual change fails the build.
 *
 *   npm run test:visual               compare
 *   npm run test:visual:update        accept the current look as the new baseline
 *
 * Fonts render differently per operating system, so baselines are kept per platform
 * (browser-tests/baselines/<platform>/). A platform with no baseline yet records one and
 * passes; CI uploads what it recorded so it can be committed. Anything that changes by
 * itself — clocks, "Updated" times, QR codes, the version number — is masked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const { webkit, chromium, devices } = require('playwright');
const { serve, USERS } = require('../scripts/preview');

const PLATFORM = process.platform;
const BASE_DIR = path.join(__dirname, 'baselines', PLATFORM);
const OUT_DIR = path.join(__dirname, 'visual-output');
const UPDATE = process.env.QD_UPDATE_BASELINES === '1';
// Friday 2026-09-11, 7:00 p.m. in Los Angeles.
const FIXED = Date.UTC(2026, 8, 12, 2, 0);
const TOLERANCE = 0.002;   // fraction of pixels allowed to differ (anti-aliasing noise)

let ctx, base;
const browsers = {};
test.before(async () => {
  ctx = await serve(0, { fixedTime: FIXED });
  base = 'http://127.0.0.1:' + ctx.server.address().port;
  browsers.chromium = await chromium.launch();
  browsers.webkit = await webkit.launch();
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
});
test.after(async () => {
  for (const b of Object.values(browsers)) await b.close();
  ctx.server.close();
});

function compare(name, buffer) {
  const baselinePath = path.join(BASE_DIR, name + '.png');
  fs.writeFileSync(path.join(OUT_DIR, name + '.png'), buffer);
  if (UPDATE || !fs.existsSync(baselinePath)) {
    fs.writeFileSync(baselinePath, buffer);
    if (!UPDATE) console.log('  recorded a new ' + PLATFORM + ' baseline: ' + name);
    return;
  }
  const actual = PNG.sync.read(buffer);
  const expected = PNG.sync.read(fs.readFileSync(baselinePath));
  assert.equal(actual.width + 'x' + actual.height, expected.width + 'x' + expected.height, name + ': page size changed');
  const diff = new PNG({ width: actual.width, height: actual.height });
  const changed = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0.12 });
  const share = changed / (actual.width * actual.height);
  if (share > TOLERANCE) {
    fs.writeFileSync(path.join(OUT_DIR, name + '.diff.png'), PNG.sync.write(diff));
    assert.fail(name + ' looks different: ' + (share * 100).toFixed(2) + '% of pixels changed. See browser-tests/visual-output/' +
      name + '.diff.png. If the change is intended, run npm run test:visual:update.');
  }
}

async function shoot(name, engine, url, contextOptions, opts) {
  opts = opts || {};
  const context = await browsers[engine].newContext(Object.assign({ timezoneId: 'America/Los_Angeles', locale: 'en-US', reducedMotion: 'reduce' }, contextOptions));
  const page = await context.newPage();
  try {
    await page.goto(base + url);
    await page.waitForSelector(opts.waitFor || 'body');
    if (opts.act) await opts.act(page);
    // No scrollbars: whether macOS shows them (and reserves their gutter) depends on a system
    // setting and whether a mouse is plugged in, which moved every button 15 px.
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } ' +
      'html, body { scrollbar-width: none !important; scrollbar-gutter: auto !important; }' });
    await page.waitForTimeout(700);
    const buffer = await page.screenshot({
      animations: 'disabled',
      mask: (opts.mask || []).map((selector) => page.locator(selector)),
      maskColor: '#ff00ff',
      fullPage: !!opts.fullPage
    });
    compare(name, buffer);
  } finally {
    await context.close();
  }
}

const screenKey = () => ctx.h.screenKey(ctx.live);
const token = () => {
  ctx.h.env.activeUser = USERS.owner;
  return new URL(ctx.h.app.getRoomScreen(ctx.live.id).url).searchParams.get('t');
};

test('visual: Admin sessions and events', () => shoot('admin-sessions', 'chromium', '/?view=admin&as=owner',
  { viewport: { width: 1280, height: 1000 } }, { waitFor: '.event', mask: ['#version'] }));

test('visual: Admin people', () => shoot('admin-people', 'chromium', '/?view=admin&as=owner',
  { viewport: { width: 1280, height: 800 } }, { waitFor: '.event', mask: ['#version'], act: (p) => p.click('[data-tab="people"]') }));

test('visual: QA Facilitator queue', () => shoot('queue', 'chromium', '/?view=moderate&s=' + ctx.live.id + '&as=mod',
  { viewport: { width: 1280, height: 1100 } }, { waitFor: '.topic', mask: ['#updated', '.live-tag'] }));

test('visual: participant page on an iPhone', () => shoot('participant-iphone', 'webkit', '/?s=' + ctx.live.id + '&t=' + token() + '&lang=en',
  devices['iPhone 15'], { waitFor: '#topicList li' }));

test('visual: room screen', () => shoot('room-screen', 'chromium', '/?view=present&s=' + ctx.live.id + '&r=' + screenKey(),
  { viewport: { width: 1600, height: 900 } }, { waitFor: '#code svg', mask: ['#code', '#clock'] }));

test('visual: PowerPoint slide (QR only)', () => shoot('slide-qr', 'chromium', '/?view=present&s=' + ctx.live.id + '&r=' + screenKey() + '&layout=qr',
  { viewport: { width: 960, height: 540 } }, { waitFor: '#code svg', mask: ['#code', '#clock'] }));

test('visual: panelist view', () => shoot('panel', 'chromium', '/?view=panel&s=' + ctx.live.id + '&r=' + screenKey(),
  { viewport: { width: 1180, height: 820 } }, { waitFor: '#question:not(:empty)', mask: ['#timer', '#clock'] }));

test('visual: landing page', () => shoot('landing', 'chromium', '/',
  { viewport: { width: 1280, height: 800 } }, { waitFor: 'main' }));
