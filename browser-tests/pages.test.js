'use strict';
/**
 * Real-browser checks in WebKit (the engine inside Safari and PowerPoint for Mac) and
 * Chromium (Chrome, Edge, PowerPoint for Windows), against the local preview with demo data.
 *
 *   npm run test:browsers          (first time: npx playwright install webkit chromium)
 *
 * These catch what the Node tests can't: layout, overlap, duplicated QR graphics,
 * a clock that doesn't tick, buttons that wait on the server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { webkit, chromium, devices } = require('playwright');
const { serve, USERS } = require('../scripts/preview');

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const ROOM_SIZES = [[1600, 900], [1280, 720], [1024, 768], [960, 540], [640, 560], [760, 760], [600, 700], [540, 900], [480, 360]];

let ctx;
let base;
const browsers = {};

test.before(async () => {
  ctx = await serve(0, { rpcDelayMs: 1200 });
  base = 'http://127.0.0.1:' + ctx.server.address().port;
  for (const [name, engine] of ENGINES) browsers[name] = await engine.launch();
});

test.after(async () => {
  for (const b of Object.values(browsers)) await b.close();
  ctx.server.close();
});

/** Opens a page, failing the test on any script error. */
async function open(engineName, url, contextOptions, onBase) {
  const context = await browsers[engineName].newContext(contextOptions || {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto((onBase || base) + url);
  return { page, context, errors };
}

/** Visible boxes for the room screen's parts, and how many QR graphics are showing. */
function roomLayout(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 1 && r.height > 1 ? r : null;
    };
    const parts = {};
    ['.brand', '.words', '#code', '#waiting', '.now', '.footer', '.clock', '.caption'].forEach((sel) => {
      const r = visible(document.querySelector(sel));
      if (r) parts[sel] = { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const qrGraphics = Array.from(document.querySelectorAll('#code svg, #code img, #code canvas')).filter((el) => visible(el)).length;
    return { parts, qrGraphics, vw: innerWidth, vh: innerHeight, clock: document.getElementById('clock').textContent };
  });
}

function overlaps(a, b) {
  const tol = 1;
  return a.x + a.w - tol > b.x && b.x + b.w - tol > a.x && a.y + a.h - tol > b.y && b.y + b.h - tol > a.y;
}

for (const [engineName] of ENGINES) {
  for (const layout of ['full', 'qr']) {
    for (const [w, h] of ROOM_SIZES) {
      test(`${engineName}: room screen (${layout}) at ${w}x${h} shows one QR code, fully visible, nothing overlapping`, async () => {
        const url = '/?view=present&s=' + ctx.live.id + '&r=' + ctx.h.screenKey(ctx.live) + (layout === 'qr' ? '&layout=qr' : '');
        const { page, context, errors } = await open(engineName, url, { viewport: { width: w, height: h } });
        try {
          await page.waitForSelector('#code svg, #code img, #code canvas', { state: 'attached', timeout: 15000 });
          await page.waitForTimeout(400);
          const L = await roomLayout(page);
          assert.equal(L.qrGraphics, 1, 'exactly one visible QR graphic');
          // PowerPoint for Mac's web view showed qrcode.js's canvas *and* image stacked.
          // Stock WebKit hides one correctly, so guard the structure: one SVG, nothing else.
          const structure = await page.evaluate(() => Array.from(document.getElementById('code').children).map((el) => el.tagName.toLowerCase()));
          assert.deepEqual(structure, ['svg'], 'QR box holds a single SVG');
          const qr = L.parts['#code'];
          assert.ok(qr.x >= 0 && qr.y >= 0 && qr.x + qr.w <= L.vw + 1 && qr.y + qr.h <= L.vh + 1,
            'QR code fully on screen: ' + JSON.stringify(qr));
          // Everything shown must be on screen, not just the code: a projector can't scroll.
          Object.keys(L.parts).forEach((name) => {
            const r = L.parts[name];
            assert.ok(r.x >= -1 && r.y >= -1 && r.x + r.w <= L.vw + 1 && r.y + r.h <= L.vh + 1,
              name + ' is cut off: ' + JSON.stringify(r) + ' in ' + L.vw + 'x' + L.vh);
          });
          const names = Object.keys(L.parts);
          for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
              assert.ok(!overlaps(L.parts[names[i]], L.parts[names[j]]),
                `${names[i]} overlaps ${names[j]}: ${JSON.stringify(L.parts[names[i]])} vs ${JSON.stringify(L.parts[names[j]])}`);
            }
          }
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  }

  test(`${engineName}: room screen clock ticks and shows when the code last updated`, async () => {
    const { page, context } = await open(engineName, '/?view=present&s=' + ctx.live.id + '&r=' + ctx.h.screenKey(ctx.live), { viewport: { width: 1280, height: 720 } });
    try {
      await page.waitForSelector('#code svg, #code img, #code canvas', { state: 'attached', timeout: 15000 });
      await page.waitForFunction(() => /code updated/.test(document.getElementById('clock').textContent), null, { timeout: 15000 });
      const first = await page.textContent('#clock');
      await page.waitForTimeout(2100);
      const second = await page.textContent('#clock');
      assert.notEqual(first, second, 'clock changed: ' + first + ' -> ' + second);
      assert.match(second, /\d{1,2}:\d{2}:\d{2}/);
      assert.equal(await page.getAttribute('#clock', 'class'), 'clock', 'not marked stale');
    } finally {
      await context.close();
    }
  });

  test(`${engineName}: queue buttons respond before the server does`, async () => {
    // Its own demo data: this test answers, dismisses and changes Now answering, which must
    // not change what the room screen tests (in the other engine) get to see.
    const own = await serve(0, { rpcDelayMs: 1200 });
    const { page, context, errors } = await open(engineName, '/?view=moderate&s=' + own.live.id + '&as=mod', { viewport: { width: 1280, height: 900 } },
      'http://127.0.0.1:' + own.server.address().port);
    try {
      await page.waitForSelector('.topic', { timeout: 15000 });
      const topic = page.locator('.topic', { hasText: 'IEP and school support' });
      const phones = topic.locator('button', { hasText: /phones/ });
      const before = await phones.textContent();
      // Timed inside the page, from the click reaching it to the label changing, so a slow
      // test machine (the click itself can take a second on CI) doesn't count against it.
      await page.evaluate((b) => {
        window.__flip = new Promise((resolve) => {
          let clickedAt = null;
          document.addEventListener('click', () => { if (clickedAt === null) clickedAt = performance.now(); }, true);
          const observer = new MutationObserver(() => {
            const t = Array.from(document.querySelectorAll('.topic')).find((el) => /IEP and school support/.test(el.textContent));
            const flipped = t && Array.from(t.querySelectorAll('button')).some((x) => /phones/.test(x.textContent) && x.textContent !== b);
            if (flipped && clickedAt !== null) { observer.disconnect(); resolve(performance.now() - clickedAt); }
          });
          observer.observe(document.getElementById('board'), { subtree: true, childList: true, characterData: true });
        });
      }, before);
      await phones.click();
      const flipMs = await page.evaluate(() => window.__flip);
      assert.ok(flipMs < 600, 'label flipped ' + Math.round(flipMs) + ' ms after the click, while the (1.2 s) server call was still running');

      const answered = topic.locator('li').first().locator('button', { hasText: 'Answered' });
      await answered.click();
      await page.waitForFunction(() => {
        const t = Array.from(document.querySelectorAll('.topic')).find((el) => /IEP and school support/.test(el.textContent));
        const items = t ? t.querySelectorAll('li') : [];
        return items.length && items[items.length - 1].classList.contains('answered');
      }, null, { timeout: 1000 });

      // Answered rows: muted text and a tag, never a struck-through Reopen button.
      const reopen = topic.locator('li.answered button', { hasText: 'Reopen' }).last();
      // Decorations are drawn from ancestors, so check the button and everything around it.
      const struck = await reopen.evaluate((b) => {
        for (let el = b; el && el.tagName !== 'BODY'; el = el.parentElement) {
          if (getComputedStyle(el).textDecorationLine.indexOf('line-through') !== -1) return el.tagName + '.' + el.className;
        }
        return '';
      });
      assert.equal(struck, '', 'Reopen is not struck through');
      assert.ok(await topic.locator('li.answered .done-tag').first().isVisible(), 'answered rows are tagged');

      // Answer now pins that topic to the top, and Stop answering is right there.
      const other = page.locator('#board .topic:not(.live)', { has: page.locator('button', { hasText: 'Answer now' }) }).nth(1);
      const name = (await other.locator('h2').evaluate((h) => h.firstChild.textContent)).trim();
      await other.locator('button', { hasText: 'Answer now' }).click();
      await page.waitForFunction((n) => document.querySelector('#board .topic h2').firstChild.textContent.trim() === n, name, { timeout: 1000 });
      assert.ok(await page.locator('#board .topic').first().locator('button', { hasText: 'Stop answering' }).isVisible());

      // Dismiss all lives in the ⋯ menu, not beside everyday buttons.
      const waitlists = page.locator('.topic', { hasText: 'Evaluation waitlists' });
      assert.equal(await waitlists.locator('.head .acts > button', { hasText: /Dismiss all/ }).count(), 0);
      await waitlists.locator('details.more summary').click();
      assert.ok(await waitlists.locator('details.more button', { hasText: /Dismiss all/ }).isVisible());
      await waitlists.locator('details.more summary').click();

      await waitlists.locator('li').first().locator('button', { hasText: 'Dismiss' }).click();
      await page.waitForFunction(() => !document.getElementById('dismissed').hidden, null, { timeout: 1000 });

      // After the server answers and a refresh runs, the changes are still there.
      await page.waitForTimeout(7000);
      assert.equal(await page.locator('#dismissedList li').count() > 0, true, 'dismissed kept after server reply');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      own.server.close();
    }
  });
}

test('webkit: participant page on an iPhone fits the screen and lists approved topics', async () => {
  const token = await (async () => {
    ctx.h.env.activeUser = USERS.owner;
    return new URL(ctx.h.app.getRoomScreen(ctx.live.id).url).searchParams.get('t');
  })();
  const { page, context, errors } = await open('webkit', '/?s=' + ctx.live.id + '&t=' + token, { ...devices['iPhone 15'] });
  try {
    await page.waitForSelector('#topicList li', { timeout: 20000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, 'no sideways scrolling, overflow ' + overflow + 'px');
    assert.ok(await page.isVisible('#send'));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('chromium: admin page loads its tabs without script errors', async () => {
  const { page, context, errors } = await open('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 900 } });
  try {
    await page.waitForSelector('.session', { timeout: 15000 });
    for (const tab of ['people', 'branding', 'activity', 'health', 'sessions']) {
      await page.click('[data-tab="' + tab + '"]');
      assert.ok(await page.isVisible('#tab-' + tab));
    }

    // Session summary recipients: a card like the other two — a list and an add box, no checkbox.
    await page.click('[data-tab="people"]');
    const card = page.locator('#summaryPanel');
    assert.equal((await card.locator('h2').textContent()).trim(), 'Session Summary Email Recipients');
    assert.equal(await card.locator('input[type=checkbox]').count(), 0);
    const cardBox = await card.boundingBox();
    const adminBox = await page.locator('#tab-people .panel', { has: page.locator('#adminList') }).boundingBox();
    assert.ok(Math.abs(cardBox.width - adminBox.width) < 2, 'same width as the Administrators card');
    await card.locator('input[type=email]').fill('board@example.org');
    await card.locator('button', { hasText: 'Add' }).click();
    await page.waitForFunction(() => /board@example\.org/.test(document.getElementById('summaryList').textContent), null, { timeout: 5000 });

    // Guest page: a checkbox per link (room screen, PowerPoint slide, panelist view); the
    // address box shows when any is ticked, and each tick changes its own link.
    await page.click('[data-tab="sessions"]');
    const editCard = page.locator('.session').first();
    const sessionName = (await editCard.locator('h3').first().evaluate((h) => h.firstChild.textContent)).trim();
    await editCard.locator('button', { hasText: 'Edit' }).click();
    await page.waitForSelector('#sessionForm:not([hidden])');
    assert.equal(await page.locator('#sessionForm input[type=radio][name=guestMode]').count(), 0);
    const urlBox = page.locator('#f-guest-url-box');
    for (const id of ['#f-guest-room', '#f-guest-slide', '#f-guest-panel']) if (await page.isChecked(id)) await page.uncheck(id);
    assert.equal(await urlBox.isVisible(), false);
    for (const id of ['#f-guest-room', '#f-guest-slide', '#f-guest-panel']) {
      await page.check(id);
      assert.equal(await urlBox.isVisible(), true, id + ' shows the address box');
      await page.uncheck(id);
    }

    // Tick only PowerPoint slide and save: the slide link (and only it) goes through the guest page.
    await page.check('#f-guest-slide');
    await page.click('#saveSession');
    await page.waitForSelector('#sessionForm', { state: 'hidden' });
    const saved = page.locator('.session', { has: page.locator('h3', { hasText: sessionName }) }).first();
    await saved.locator('button', { hasText: /^Links$/ }).click();
    const linkFor = async (label) => saved.locator('.linkrow', { has: page.locator('b', { hasText: new RegExp('^' + label + '$') }) }).locator('input').inputValue();
    assert.match(await linkFor('PowerPoint slide'), /^https:\/\/djsincla\.github\.io\/question-desk\/join\/\?d=.*&layout=qr$/, 'slide link uses the guest page');
    assert.match(await linkFor('Room screen'), /^https:\/\/script\.google\.com\//, 'room screen stays direct');
    assert.match(await linkFor('Panelist view'), /^https:\/\/script\.google\.com\//, 'panelist view stays direct');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
