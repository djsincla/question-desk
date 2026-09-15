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

async function withDemo(engineName, url, contextOptions, fn, serveOptions) {
  const ctx = await serve(0, serveOptions);
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
    // Build the new row from the exported header, so adding a column never breaks this test.
    const header = csv.split(/\r?\n/)[0].split('","').map((h) => h.replace(/^\uFEFF?"|"$/g, ''));
    const values = { 'Event': 'Fall Family Conference 2026', 'Session': 'Evening wrap-up', 'Heading participants see': 'Last questions',
      'How people join (room or link)': 'room', 'Seconds between questions': '60', 'Longest question (characters)': '300' };
    const row = header.map((h) => '"' + (values[h] || '') + '"').join(',');
    const edited = csv.trim() + '\r\n' + row;
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

test('chromium: an ungrouped question goes on phones with its own button, and phones can tap Me too', async () => {
  await withDemo('chromium', (ctx) => {
    const h = ctx.h;
    h.env.activeUser = '';
    h.ask(ctx.live, h.join(ctx.live), 'Will there be childcare at the next meeting?');
    return '/?view=moderate&s=' + ctx.live.id + '&as=mod';
  }, { viewport: { width: 1280, height: 900 } }, async ({ page, ctx }) => {
    const row = page.locator('li[data-id]', { hasText: 'childcare at the next meeting' });
    await row.waitFor();
    const qid = await row.getAttribute('data-id');
    await row.locator('button', { hasText: 'Show on phones' }).click();
    await row.locator('button', { hasText: 'On phones ✓' }).waitFor({ timeout: 1000 });   // before the server answers
    await page.waitForTimeout(1500);
    ctx.h.env.activeUser = '';
    const phone = ctx.h.join(ctx.live);
    const entry = ctx.h.app.getTopics(ctx.live.id, phone.deviceId).topics.find((t) => t.topic === 'q:' + qid);
    assert.ok(entry, 'on phones');
    assert.equal(ctx.h.app.meToo(ctx.live.id, phone.deviceId, entry.topic).ok, true);
    // The queue shows the Me too count on the question after its next refresh.
    await row.locator('.votes', { hasText: '+1 me too' }).waitFor({ timeout: 12000 });

    // P toggles it from the keyboard too.
    const selected = () => page.evaluate(() => { const li = document.querySelector('li.selected'); return li && li.getAttribute('data-id'); });
    for (let i = 0; i < 40 && (await selected()) !== qid; i++) await page.keyboard.press('j');
    assert.equal(await page.getAttribute('li.selected', 'data-id'), qid, 'J reaches the question');
    await page.keyboard.press('p');
    await row.locator('button', { hasText: 'Show on phones' }).waitFor({ timeout: 1000 });
  });
});

test('chromium: a merge says it is working, and says why when Gemini fails, then works on retry', async () => {
  await withDemo('chromium', (ctx) => '/?view=moderate&s=' + ctx.live.id + '&as=mod', { viewport: { width: 1280, height: 900 } }, async ({ page, ctx }) => {
    await page.waitForSelector('.topic [data-key="merge"]');
    const topic = page.locator('.topic', { has: page.locator('[data-key="merge"]', { hasText: 'Merge into one question' }) }).first();
    const name = await topic.getAttribute('data-topic');
    const demo = ctx.h.env.gemini;
    ctx.h.env.gemini = () => ({ status: 429, text: 'quota exceeded' });
    await topic.locator('[data-key="merge"]').click();
    const block = page.locator('.topic[data-topic="' + name + '"]');
    await block.locator('.merge-error', { hasText: 'Gemini is busy or out of quota' }).waitFor({ timeout: 5000 });
    assert.match(await block.locator('[data-key="merge"]').textContent(), /Merge failed — retry/);

    ctx.h.env.gemini = demo;
    // Watch for the "working" note: the demo's Gemini answers too fast to catch it afterwards.
    await page.evaluate(() => {
      window.sawBusy = false;
      new MutationObserver(() => { if (document.querySelector('.merge-busy')) window.sawBusy = true; }).observe(document.body, { childList: true, subtree: true });
    });
    await block.locator('[data-key="merge"]').click();
    await block.locator('.merged').waitFor({ timeout: 8000 });
    assert.equal(await page.evaluate(() => window.sawBusy), true, 'said it was working');
    assert.equal(await block.locator('.merge-error').count(), 0);
  });
});

test('chromium: Gemini settings on the Health tab save, try out, and list models', async () => {
  await withDemo('chromium', '/?view=admin&as=owner', { viewport: { width: 1280, height: 1000 } }, async ({ page, ctx }) => {
    await page.waitForSelector('.event');
    await page.click('[data-tab="health"]');
    await page.waitForSelector('#geminiPanel');
    assert.equal(await page.inputValue('#gem-model'), ctx.h.app.CONFIG.model);
    assert.equal(await page.inputValue('#gem-think-merging'), 'low');

    await page.selectOption('#gem-think-grouping', 'high');
    await page.fill('#gem-batch', '15');
    await page.click('#gem-test');
    await page.waitForFunction(() => document.querySelectorAll('#gem-results tr').length === 3 && /seconds/.test(document.getElementById('gem-results').textContent), null, { timeout: 5000 });
    ctx.h.env.activeUser = USERS.owner;
    assert.equal(ctx.h.app.adminState().gemini.thinking.grouping, 'default', 'trying saves nothing');

    await page.click('#gem-save');
    await page.waitForFunction(() => /Gemini settings saved/.test(document.body.textContent), null, { timeout: 5000 });
    ctx.h.env.activeUser = USERS.owner;
    const saved = ctx.h.app.adminState().gemini;
    assert.equal(saved.thinking.grouping, 'high');
    assert.equal(saved.batchSize, 15);

    await page.click('#gem-list');
    await page.waitForFunction(() => document.querySelectorAll('#gem-models option').length === 3, null, { timeout: 5000 });
    assert.match(await page.textContent('#gem-list-note'), /3 models/);
  });
});

test('chromium: the Admin tab row shows no scrollbar when the browser always shows scrollbars', async () => {
  // Seen live in Chrome with "always show scrollbars": the tab underline pokes 1px past the
  // row, and the row's sideways scrolling (for phones) turned that into a small vertical bar.
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  const ctx = await serve(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:' + ctx.server.address().port + '/?view=admin&as=owner');
    await page.waitForSelector('nav.tabs button');
    const bars = await page.$eval('nav.tabs', (el) => {
      const cs = getComputedStyle(el);
      const px = (v) => parseFloat(v) || 0;
      return {
        vertical: el.offsetWidth - el.clientWidth - px(cs.borderLeftWidth) - px(cs.borderRightWidth),
        horizontal: el.offsetHeight - el.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth)
      };
    });
    assert.deepEqual(bars, { vertical: 0, horizontal: 0 }, 'scrollbar space inside the tab row');
  } finally {
    await context.close();
    await browser.close();
    ctx.server.close();
  }
});

test('chromium: questions dismissed in quick succession stay dismissed through saves and refreshes', async () => {
  // Live: several quick Dismiss clicks, and some came back. Saves run in parallel, and Apps Script
  // can answer them out of order: here the first Dismiss answers last, carrying a queue from
  // before the other two dismissals.
  await withDemo('chromium', (ctx) => '/?view=moderate&s=' + ctx.live.id + '&as=mod', { viewport: { width: 1280, height: 1000 } }, async ({ page, ctx }) => {
    await page.waitForSelector('#board li[data-id] button');
    const ids = await page.$$eval('#board .topic li[data-id]', (lis) => lis.slice(0, 3).map((li) => li.getAttribute('data-id')));
    assert.equal(ids.length, 3);
    for (const id of ids) {
      await page.locator('#board li[data-id="' + id + '"] button', { hasText: 'Dismiss' }).click();
      await page.waitForTimeout(150);
    }
    const onBoard = () => page.$$eval('#board .topic li[data-id]', (lis, gone) => lis.map((li) => li.getAttribute('data-id')).filter((id) => gone.indexOf(id) !== -1), ids);
    // Watch every redraw from here on: none may bring a dismissed question back.
    await page.evaluate((gone) => {
      window.cameBack = [];
      new MutationObserver(() => {
        document.querySelectorAll('#board .topic li[data-id]').forEach((li) => {
          if (gone.indexOf(li.getAttribute('data-id')) !== -1) window.cameBack.push(li.getAttribute('data-id'));
        });
      }).observe(document.getElementById('board'), { childList: true, subtree: true });
    }, ids);
    await page.waitForTimeout(12000);   // every save answered, then two refreshes
    assert.deepEqual(await onBoard(), [], 'no dismissed question on the board');
    assert.deepEqual(await page.evaluate(() => window.cameBack), [], 'none reappeared at any point');
    ctx.h.env.activeUser = USERS.mod;
    const dismissed = ctx.h.app.getBoard(ctx.live.id).dismissed.map((q) => q.id);
    ids.forEach((id) => assert.ok(dismissed.indexOf(id) !== -1, id + ' saved as dismissed'));
  }, { rpcReplyDelay: (fn, n) => (fn === 'setStatus' ? [0, 3000, 2000, 1000][n] || 500 : 300) });
});

for (const engineName of ['chromium', 'webkit']) {
test(engineName + ': the queue keeps its place when a refresh brings changes', async () => {
  // Live: the page jumped at every refresh. After clicking a button, each redraw put focus back on
  // it with a scroll, and new questions above pushed what the facilitator was reading down.
  await withDemo(engineName, (ctx) => '/?view=moderate&s=' + ctx.live.id + '&as=mod', { viewport: { width: 1280, height: 700 } }, async ({ page, ctx }) => {
    await page.waitForSelector('.topic li[data-id]');
    // Click something near the top, so focus stays there, then scroll down to read.
    // The ⋯ menu button: opened and closed, focus stays on it, and its label never changes.
    const more = page.locator('.topic').first().locator('details.more summary');
    await more.click();
    await more.click();
    await more.focus();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, 650));
    await page.waitForTimeout(300);
    const anchor = () => page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#board li[data-id]'));
      const row = rows.find((r) => r.getBoundingClientRect().top >= 0);
      return { id: row.getAttribute('data-id'), top: Math.round(row.getBoundingClientRect().top), y: scrollY };
    });
    const before = await anchor();
    assert.ok(before.y > 400, 'scrolled down: ' + before.y);

    // New questions arrive in the first topic (above the reader) and get grouped there.
    const topTopic = await page.locator('.topic').first().getAttribute('data-topic');
    ctx.h.env.activeUser = '';
    for (let i = 0; i < 3; i++) ctx.h.ask(ctx.live, ctx.h.join(ctx.live), 'Another question about ' + topTopic + ' number ' + i);
    ctx.h.env.activeUser = USERS.mod;
    const fresh = ctx.h.app.getBoard(ctx.live.id).unsorted.map((q) => q.id);
    ctx.h.app.groupQuestions(ctx.live.id, fresh, topTopic);

    const count = await page.$$eval('#board li[data-id]', (l) => l.length);
    await page.waitForFunction((n) => document.querySelectorAll('#board li[data-id]').length >= n, count + 3, { timeout: 12000 });
    await page.waitForTimeout(500);
    const after = await page.evaluate((id) => {
      const row = document.querySelector('#board li[data-id="' + id + '"]');
      return { top: Math.round(row.getBoundingClientRect().top), y: scrollY };
    }, before.id);
    assert.ok(Math.abs(after.top - before.top) <= 2, 'the question being read stayed put: ' + before.top + ' → ' + after.top + ' (scroll ' + before.y + ' → ' + after.y + ')');
    // The rise-in animation plays once, when a topic first appears, not on every refresh.
    assert.equal(await page.$$eval('#board > .topic.arrived', (t) => t.length), 0, 'no existing topic animates again');
    ctx.h.env.activeUser = '';
    ctx.h.ask(ctx.live, ctx.h.join(ctx.live), 'Is there a quiet room for kids who need a break?');
    ctx.h.env.activeUser = USERS.mod;
    const loose = ctx.h.app.getBoard(ctx.live.id).unsorted.map((q) => q.id);
    ctx.h.app.groupQuestions(ctx.live.id, loose, 'Quiet spaces');
    await page.waitForSelector('#board > .topic[data-topic="Quiet spaces"]', { timeout: 12000 });
    assert.deepEqual(await page.$$eval('#board > .topic.arrived', (t) => t.map((x) => x.getAttribute('data-topic'))), ['Quiet spaces'], 'only the new topic rises in');
  });
});
}
