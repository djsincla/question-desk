'use strict';
/**
 * Page behavior over time, each test on its own demo server so no test sees another's
 * changes: the room screen's status line, the queue keeping menus open across refreshes,
 * and the participant page following a paused and resumed session.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { webkit, chromium, devices } = require('playwright');
const { serve, USERS } = require('../scripts/preview');

const browsers = {};
test.before(async () => {
  browsers.webkit = await webkit.launch();
  browsers.chromium = await chromium.launch();
});
test.after(async () => {
  for (const b of Object.values(browsers)) await b.close();
});

async function withDemo(engineName, url, contextOptions, fn) {
  const ctx = await serve(0);
  const base = 'http://127.0.0.1:' + ctx.server.address().port;
  const context = await browsers[engineName].newContext(contextOptions || {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const as = (who, fnName, ...args) => { ctx.h.env.activeUser = USERS[who]; return ctx.h.app[fnName](...args); };
  try {
    await page.goto(base + (typeof url === 'function' ? url(ctx) : url));
    await fn({ page, ctx, as, errors });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    ctx.server.close();
  }
}

for (const engineName of ['webkit', 'chromium']) {
  test(`${engineName}: room screen says when questions are paused`, async () => {
    await withDemo(engineName, (ctx) => '/?view=present&s=' + ctx.live.id + '&r=' + ctx.h.screenKey(ctx.live), { viewport: { width: 1280, height: 720 } }, async ({ page, ctx, as }) => {
      await page.waitForFunction(() => /Code refreshes automatically/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
      as('owner', 'setBoardOpen', ctx.live.id, false);
      await page.waitForFunction(() => /Questions are paused/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
      assert.ok(await page.isVisible('#status'));
    });
  });
}

test('chromium: queue keeps an open ⋯ menu open through background refreshes', async () => {
  await withDemo('chromium', (ctx) => '/?view=moderate&s=' + ctx.live.id + '&as=mod', { viewport: { width: 1280, height: 900 } }, async ({ page }) => {
    await page.waitForSelector('.topic details.more');
    const menu = page.locator('.topic details.more').nth(1);
    await menu.locator('summary').click();
    assert.equal(await menu.evaluate((d) => d.open), true);
    await page.waitForTimeout(11000);   // two refreshes
    assert.equal(await page.locator('.topic details.more[open]').count(), 1, 'still open after refreshes');
    assert.ok(await page.locator('.topic details.more[open] button', { hasText: /Dismiss all/ }).isVisible());
  });
});

test('webkit: participant page unlocks when a paused session resumes, and a changed wait keeps typed text', async () => {
  await withDemo('webkit', (ctx) => {
    ctx.h.env.activeUser = USERS.owner;
    const token = new URL(ctx.h.app.getRoomScreen(ctx.live.id).url).searchParams.get('t');
    return '/?s=' + ctx.live.id + '&t=' + token + '&lang=en';
  }, { ...devices['iPhone 15'] }, async ({ page, ctx, as }) => {
    await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 20000 });

    as('owner', 'setBoardOpen', ctx.live.id, false);
    await page.fill('#q', 'Is there parking nearby?');
    await page.click('#send');
    await page.waitForFunction(() => document.getElementById('q').disabled, null, { timeout: 10000 });

    as('owner', 'setBoardOpen', ctx.live.id, true);
    // The page polls every 15 seconds; it must unlock on its own, without a reload.
    await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 25000 });

    // With no wait between questions, "Sent" stays on screen and the box is ready again.
    const session = ctx.h.app.getSession_(ctx.live.id);
    as('owner', 'saveSession', { id: session.id, name: session.name, access: session.access, cooldownSeconds: 0 });
    await page.fill('#q', 'Is there parking nearby?');
    await page.click('#send');
    await page.waitForFunction(() => /Sent/.test(document.getElementById('noteText').textContent) && !document.getElementById('q').disabled, null, { timeout: 10000 });
    await page.waitForTimeout(1500);
    assert.match(await page.textContent('#noteText'), /Sent/, '"Sent" is not replaced straight away');

    // The facilitator raises the wait while someone is typing: the text must survive the sync.
    await page.fill('#q', 'Half-typed question about respite');
    as('owner', 'saveSession', { id: session.id, name: session.name, access: session.access, cooldownSeconds: 600 });
    await page.waitForFunction(() => document.getElementById('q').disabled, null, { timeout: 20000 });
    assert.equal(await page.inputValue('#q'), 'Half-typed question about respite');
  });
});

test('chromium: an admin creates an event and adds a session to it', async () => {
  await withDemo('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 900 } }, async ({ page }) => {
    await page.waitForSelector('.event');
    await page.click('#newEvent');
    await page.fill('#ev-name', 'Winter Workshop');
    await page.fill('#ev-org', 'Winter Partners');
    await page.click('#saveEvent');
    const block = page.locator('.event', { has: page.locator('h2', { hasText: 'Winter Workshop' }) });
    await block.waitFor({ timeout: 10000 });
    assert.match(await block.locator('.meta').textContent(), /0 sessions · branded as Winter Partners/);

    await block.locator('button', { hasText: 'Add session' }).click();
    assert.equal(await page.locator('#f-event option:checked').textContent(), 'Winter Workshop', 'Add session presets the event');
    await page.fill('#f-name', 'Morning breakout');
    await page.click('#saveSession');
    await block.locator('.session h3', { hasText: 'Morning breakout' }).waitFor({ timeout: 10000 });
    assert.match(await block.locator('.meta').first().textContent(), /1 session/);
  });
});
