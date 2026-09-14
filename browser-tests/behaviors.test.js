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

test('chromium: export sessions to CSV, then check and import an edited file', async () => {
  await withDemo('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 900 } }, async ({ page }) => {
    await page.waitForSelector('.event');
    await page.click('#exportCsv');
    await page.waitForSelector('#exportPanel:not([hidden])');
    const csv = await page.inputValue('#exportText');
    assert.match(csv.split('\n')[0], /^"Event","Session",/);
    assert.match(csv, /Family Resource Night — September/);

    await page.click('#importCsv');
    const edited = csv.trim() + '\r\n"Fall Family Conference 2026","Evening wrap-up","Last questions","room","dark","60","300","yes","","","","default","","","no","no","","","","","yes","inactive"';
    await page.fill('#importText', edited);
    await page.click('#importCheck');
    await page.waitForSelector('.import-table');
    const summary = await page.textContent('#importPreview p');
    assert.match(summary, /1 to create/);
    assert.match(summary, /0 with problems/);
    await page.click('#importGo');
    await page.waitForFunction(() => /Imported: 1 created/.test(document.querySelector('#importPreview p').textContent), null, { timeout: 10000 });
    const conference = page.locator('.event', { has: page.locator('h2', { hasText: 'Fall Family Conference 2026' }) });
    await conference.locator('.session h3', { hasText: 'Evening wrap-up' }).waitFor({ timeout: 10000 });
  });
});

test('chromium: the Activity tab lists what staff did, newest first, and filters', async () => {
  await withDemo('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 900 } }, async ({ page }) => {
    await page.waitForSelector('.event');
    await page.click('[data-tab="activity"]');
    await page.waitForFunction(() => document.querySelectorAll('#actTable tr').length > 3, null, { timeout: 10000 });
    const first = await page.locator('#actTable tr').nth(1).locator('td').allTextContents();
    assert.ok(first[1].length > 0 && first[2].length > 0, 'who and action shown: ' + first.join(' | '));
    await page.fill('#actSearch', 'Answer now');
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('#actTable tr')).slice(1);
      return rows.length && rows.every((r) => /Answer now/.test(r.textContent));
    }, null, { timeout: 10000 });
    assert.match(await page.textContent('#actTable'), /maria@example\.org/);
  });
});

test('chromium: events collapse and expand, one at a time or all, and stay that way after a reload', async () => {
  await withDemo('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 900 } }, async ({ page }) => {
    await page.waitForSelector('.event[data-event]');
    const first = page.locator('.event[data-event]').first();
    const sessionsVisible = () => first.locator('.event-sessions').isVisible();
    assert.equal(await sessionsVisible(), true);
    await first.locator('button.collapse').click();
    await page.waitForTimeout(350);   // the fold animates
    assert.equal(await sessionsVisible(), false, 'collapsed');
    assert.equal(await page.textContent('#foldAll'), 'Collapse all events', 'one folded is not all folded');
    assert.equal(await first.locator('button.collapse').getAttribute('aria-expanded'), 'false');
    assert.match(await first.locator('.event-head .meta').textContent(), /session/, 'the count stays visible while collapsed');

    await page.reload();
    await page.waitForSelector('.event[data-event]');
    assert.equal(await page.locator('.event[data-event]').first().locator('.event-sessions').isVisible(), false, 'remembered');

    await page.locator('.event[data-event]').first().locator('h2').click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.event[data-event]').first().locator('.event-sessions').isVisible(), true, 'clicking the name expands it');

    await page.click('button:has-text("Collapse all events")');
    assert.equal(await page.locator('.event[data-event]:not(.collapsed)').count(), 0);
    assert.equal(await page.textContent('#foldAll'), 'Expand all events');
    await page.click('button:has-text("Expand all events")');
    assert.equal(await page.locator('.event[data-event].collapsed').count(), 0);
    await page.waitForTimeout(500);   // let that expand finish before measuring the full height

    // It slides rather than jumps: halfway through, the sessions area is partly open.
    // Sampled every frame, so a busy machine can't make the check miss the animation.
    const heights = await page.evaluate(() => new Promise((resolve) => {
      const block = document.querySelector('.event[data-event]');
      const fold = block.querySelector('.event-fold');
      const full = fold.getBoundingClientRect().height;
      const seen = [];
      block.querySelector('button.collapse').click();
      const start = performance.now();
      (function sample() {
        seen.push(fold.getBoundingClientRect().height);
        if (performance.now() - start < 600) requestAnimationFrame(sample); else resolve({ full, seen });
      })();
    }));
    const between = heights.seen.filter((x) => x > 2 && x < heights.full - 2);
    assert.ok(between.length > 0, 'slides through in-between heights: ' + heights.seen.map(Math.round).join(','));
    assert.ok(heights.seen[heights.seen.length - 1] <= 1, 'ends closed');
  });
});

test('chromium: queue keyboard shortcuts select, answer and dismiss, and the live topic shows a timer', async () => {
  await withDemo('chromium', (ctx) => '/?view=moderate&s=' + ctx.live.id + '&as=mod', { viewport: { width: 1280, height: 900 } }, async ({ page }) => {
    await page.waitForSelector('li[data-id]');
    await page.waitForFunction(() => /Answering now · \d+:\d{2}/.test((document.querySelector('.live-tag') || {}).textContent || ''), null, { timeout: 5000 });

    await page.keyboard.press('j');
    const first = await page.getAttribute('li.selected', 'data-id');
    assert.ok(first, 'J selects the first question');
    await page.keyboard.press('j');
    const second = await page.getAttribute('li.selected', 'data-id');
    assert.notEqual(second, first);
    await page.keyboard.press('k');
    assert.equal(await page.getAttribute('li.selected', 'data-id'), first);

    await page.keyboard.press('a');
    await page.waitForFunction((id) => document.querySelector('li[data-id="' + id + '"]').classList.contains('answered'), first, { timeout: 2000 });
    assert.notEqual(await page.getAttribute('li.selected', 'data-id'), first, 'moves on after answering');

    const target = await page.getAttribute('li.selected', 'data-id');
    await page.keyboard.press('d');
    await page.waitForFunction((id) => !document.querySelector('#board li[data-id="' + id + '"]'), target, { timeout: 2000 });

    // Typing in a field never triggers shortcuts.
    await page.click('#originals');
    await page.keyboard.press('?');
    assert.equal(await page.isVisible('#dialog'), true, '? opens the shortcut list');
    assert.match(await page.textContent('#dialogBody'), /Dismiss/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#dialog'), false);
  });
});

test('webkit: the panelist view shows the question being answered, large, with a running timer', async () => {
  await withDemo('webkit', (ctx) => '/?view=panel&s=' + ctx.live.id + '&r=' + ctx.h.screenKey(ctx.live), { viewport: { width: 1024, height: 768 } }, async ({ page, ctx, as }) => {
    await page.waitForFunction(() => !document.getElementById('live').hidden, null, { timeout: 15000 });
    assert.match(await page.textContent('#question'), /respite care hours/i);
    const t1 = await page.textContent('#timer');
    await page.waitForTimeout(1500);
    assert.notEqual(await page.textContent('#timer'), t1, 'timer ticks');
    const size = await page.$eval('#question', (el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(size >= 36, 'large type: ' + size + 'px');

    as('mod', 'setNowAnswering', ctx.live.id, null);
    await page.waitForFunction(() => document.getElementById('live').hidden && !document.getElementById('waiting').hidden, null, { timeout: 15000 });
  });
});

test('webkit: participant page offers the event\'s languages, larger text, and marks your answered question', async () => {
  await withDemo('webkit', (ctx) => {
    ctx.h.env.activeUser = USERS.owner;
    const token = new URL(ctx.h.app.getRoomScreen(ctx.live.id).url).searchParams.get('t');
    return '/?s=' + ctx.live.id + '&t=' + token + '&lang=en';
  }, { ...devices['iPhone 15'] }, async ({ page, ctx, as }) => {
    await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 20000 });
    const langs = await page.$$eval('#langs button[data-lang]', (b) => b.map((x) => x.getAttribute('data-lang')));
    assert.deepEqual(langs, ['en', 'ko', 'es', 'zh']);
    await page.click('#langs button[data-lang="zh"]');
    assert.equal(await page.getAttribute('#send', 'id'), 'send');
    assert.match(await page.textContent('#sub'), /主持人/);
    assert.equal(await page.getAttribute('html', 'lang'), 'zh');
    await page.click('#langs button[data-lang="en"]');

    const before = await page.$eval('#q', (el) => parseFloat(getComputedStyle(el).fontSize));
    await page.click('#bigText');
    const after = await page.$eval('#q', (el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(after > before, 'larger text: ' + before + ' → ' + after);
    assert.equal(await page.getAttribute('#bigText', 'aria-pressed'), 'true');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, 'still no sideways scrolling with larger text');

    const session = ctx.h.app.getSession_(ctx.live.id);
    as('owner', 'saveSession', { id: session.id, name: session.name, access: session.access, moderators: session.moderators, cooldownSeconds: 0 });
    await page.fill('#q', 'When do respite hours get assigned?');
    await page.click('#send');
    await page.waitForSelector('#sentList li');
    const row = ctx.h.questions().rows.find((r) => r[3] === 'When do respite hours get assigned?');
    as('mod', 'setStatus', ctx.live.id, [row[0]], 'answered');
    await page.waitForSelector('#sentList li.done .tick', { timeout: 25000 });
    assert.match(await page.textContent('#noteText'), /marked a question you asked as answered/);
  });
});

test('chromium: collapsing events never shifts the page sideways (the scrollbar keeps its space)', async () => {
  // Headless Chromium hides scrollbars unless told not to; real browsers on Windows and
  // Macs with a mouse show them, and that's where the page jumped.
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  const ctx = await serve(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:' + ctx.server.address().port + '/?view=admin&as=owner');
    await page.waitForSelector('.event[data-event]');
    const left = () => page.$eval('header', (el) => Math.round(el.getBoundingClientRect().left * 10) / 10);
    const fits = () => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
    assert.equal(await fits(), false, 'the page starts taller than the window');
    const before = await left();
    await page.click('button:has-text("Collapse all events")');
    await page.waitForTimeout(400);
    assert.equal(await fits(), true, 'collapsed, the page fits: this is when a scrollbar would vanish');
    const after = await left();
    assert.equal(after, before, 'content moved sideways by ' + (after - before) + 'px');
    await page.click('button:has-text("Expand all events")');
    await page.waitForTimeout(400);
    assert.equal(await left(), before);
  } finally {
    await context.close();
    await browser.close();
    ctx.server.close();
  }
});

test('chromium: event More menu opens the day-of checklist; sessions duplicate; QR sheets render a code per link session', async () => {
  await withDemo('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 900 } }, async ({ page, ctx }) => {
    await page.waitForSelector('.event[data-event]');
    const conference = page.locator('.event', { has: page.locator('h2', { hasText: 'Fall Family Conference 2026' }) });
    await conference.locator('details.more summary').click();
    await conference.locator('details.more button', { hasText: 'Day-of checklist' }).click();
    await page.waitForFunction(() => /checked/.test(document.getElementById('checklistWhen').textContent), null, { timeout: 10000 });
    const text = await page.textContent('#checklistBody');
    assert.match(text, /Whole app/);
    assert.match(text, /Family Resource Night — September/);
    assert.match(text, /QA Facilitators/);
    assert.ok(await page.locator('#checklistBody .linkrow').count() > 0, 'links to copy for each session');

    const before = await conference.locator('.session').count();
    await conference.locator('.session', { hasText: 'Parent Support Circle' }).locator('button', { hasText: 'Duplicate' }).click();
    await conference.locator('.session h3', { hasText: 'Parent Support Circle (Spanish) (copy)' }).waitFor({ timeout: 10000 });
    assert.equal(await conference.locator('.session').count(), before + 1);

    const eid = await conference.getAttribute('data-event');
    const base = 'http://127.0.0.1:' + ctx.server.address().port;
    const sheet = await page.context().newPage();
    await sheet.goto(base + '/?view=qrsheet&e=' + eid + '&as=owner');
    await sheet.waitForSelector('.page .qr svg');
    const pages = await sheet.locator('.page').count();
    assert.equal(pages, 2, 'the link session and its copy');
    assert.equal(await sheet.locator('.page').first().locator('.qr svg').count(), 1);
    assert.match(await sheet.textContent('#skipped'), /Family Resource Night — September/);
    assert.match(await sheet.textContent('.page .scan'), /扫码提问/, 'the event\'s languages');
    await sheet.close();
  });
});

test('chromium: during a Gemini outage the queue explains it and sorts new questions by shared words', async () => {
  await withDemo('chromium', (ctx) => {
    const h = ctx.h;
    h.env.activeUser = '';
    h.ask(ctx.live, h.join(ctx.live), 'Is there free parking near the hall?');
    h.ask(ctx.live, h.join(ctx.live), 'Parking fills up too early');
    h.env.gemini = () => ({ status: 503, text: 'Service unavailable' });
    h.app.clusterAll_();
    h.app.clusterAll_();
    return '/?view=moderate&s=' + ctx.live.id + '&as=mod';
  }, { viewport: { width: 1280, height: 900 } }, async ({ page }) => {
    await page.waitForSelector('#groupingNotice:not([hidden])', { timeout: 10000 });
    assert.match(await page.textContent('#groupingNotice'), /isn't working right now[\s\S]*503/);
    const heads = await page.$$eval('.topic h2', (hs) => hs.map((x) => x.textContent));
    assert.ok(heads.some((t) => /Not yet grouped · mentions “parking”/.test(t)), heads.join(' | '));
  });
});

test('chromium: Data and reports settings save, and removing wording asks first', async () => {
  await withDemo('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 900 } }, async ({ page, ctx }) => {
    await page.waitForSelector('.event');
    await page.click('[data-tab="health"]');
    assert.match(await page.textContent('#ops-storage'), /% of the 500 KB/);
    await page.selectOption('#ops-retention', '12');
    await page.uncheck('#ops-weekly');
    await page.click('#ops-save');
    await page.waitForSelector('#dialog:not([hidden])');
    assert.match(await page.textContent('#dialogBody'), /12 months/);
    await page.click('#dialogOk');
    await page.waitForFunction(() => /Saved/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    ctx.h.env.activeUser = USERS.owner;
    assert.deepEqual(ctx.h.app.adminState().ops, { retentionMonths: 12, weeklyReport: false });
  });
});

test('chromium: tick questions, group them by hand, ungroup, and answer an ungrouped question right away', async () => {
  await withDemo('chromium', (ctx) => {
    const h = ctx.h;
    h.env.activeUser = '';
    h.ask(ctx.live, h.join(ctx.live), 'Can the library stay open later on event nights?');
    h.ask(ctx.live, h.join(ctx.live), 'Are there quiet rooms at the library?');
    return '/?view=moderate&s=' + ctx.live.id + '&as=mod';
  }, { viewport: { width: 1280, height: 900 } }, async ({ page, ctx }) => {
    await page.waitForSelector('li[data-id]');
    const loose = page.locator('.topic', { has: page.locator('h2', { hasText: /^Not yet grouped/ }) });
    const rowFor = (text) => page.locator('li[data-id]', { hasText: text });

    // Answer now on an ungrouped question: no grouping needed.
    await rowFor('library stay open').locator('button', { hasText: 'Answer now' }).click();
    await rowFor('library stay open').locator('.row-live-tag').waitFor({ timeout: 2000 });
    await page.waitForTimeout(1500);
    ctx.h.env.activeUser = USERS.mod;
    assert.match(ctx.h.app.getRoomScreen(ctx.live.id).nowAnswering.labels.en, /library stay open/);

    // Tick two questions and group them.
    await rowFor('library stay open').locator('input.pick').check();
    await rowFor('quiet rooms at the library').locator('input.pick').check();
    await page.waitForSelector('#selection:not([hidden])');
    assert.match(await page.textContent('#selCount'), /2 questions selected/);
    await page.click('#selGroup');
    await page.fill('#groupName', 'The library');
    await page.click('#groupOk');
    const libraryTopic = page.locator('.topic', { has: page.locator('h2', { hasText: /^The library/ }) });
    await libraryTopic.waitFor({ timeout: 2000 });
    assert.equal(await libraryTopic.locator('li[data-id]').count(), 2);
    assert.equal(await page.isVisible('#selection'), false, 'selection cleared');

    // Ungroup one of them again.
    await rowFor('quiet rooms at the library').locator('input.pick').check();
    await page.click('#selUngroup');
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('.topic')).some((t) => /^The library/.test(t.querySelector('h2').textContent) && t.textContent.includes('quiet rooms')), null, { timeout: 2000 });
    await page.waitForTimeout(1500);
    const row = ctx.h.questions().rows.find((r) => /quiet rooms at the library/.test(r[3]));
    assert.equal(row[5], '', 'saved as ungrouped');

    // The switches are there and reflect the session.
    assert.equal(await page.isChecked('#autoGroup'), true);
    await page.uncheck('#autoGroup');
    await page.waitForTimeout(1500);
    assert.equal(ctx.h.app.getSession_(ctx.live.id).autoGroup, false);
  });
});
