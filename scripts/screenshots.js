#!/usr/bin/env node
'use strict';
/**
 * Regenerates docs/screenshots/*.png from the local preview (demo data only).
 *
 *   node scripts/screenshots.js                 all screenshots
 *   node scripts/screenshots.js room            only shots whose name contains "room"
 *   OUT=/tmp/shots node scripts/screenshots.js  write somewhere else
 *
 * Needs Google Chrome. Set CHROME=/path/to/chrome if it isn't in the usual place.
 */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
// Async on purpose: the preview server runs in this process and must keep answering Chrome.
const run = promisify(execFile);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serve, USERS } = require('./preview');

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => fs.existsSync(p));
const OUT = process.env.OUT || path.join(__dirname, '..', 'docs', 'screenshots');

function shots(ctx) {
  const s = ctx.live.id;
  const token = () => {
    ctx.h.env.activeUser = USERS.owner;
    return new URL(ctx.h.app.getRoomScreen(s).url).searchParams.get('t');
  };
  const phone = (src) => '/phone?src=' + encodeURIComponent(src);
  const setNow = (topic) => () => { ctx.h.env.activeUser = USERS.mod; ctx.h.app.setNowAnswering(s, topic); };
  return [
    { name: 'room-screen', url: () => '/?view=present&s=' + s + '&as=owner', size: [1600, 900], before: setNow(null) },
    { name: 'room-screen-answering', url: () => '/?view=present&s=' + s + '&as=owner', size: [1600, 900], before: setNow('Respite care hours') },
    { name: 'room-screen-1280', url: () => '/?view=present&s=' + s + '&as=owner', size: [1280, 720], check: true },
    { name: 'room-screen-1024', url: () => '/?view=present&s=' + s + '&as=owner', size: [1024, 768], check: true },
    { name: 'participant-phone', url: () => phone('/?s=' + s + '&t=' + token() + '&lang=en'), size: [600, 844], crop: [390, 844], scale: 2, before: setNow('Respite care hours') },
    { name: 'participant-phone-korean', url: () => phone('/?s=' + s + '&t=' + token() + '&lang=ko'), size: [600, 844], crop: [390, 844], scale: 2 },
    { name: 'facilitator-queue', url: () => '/?view=moderate&s=' + s + '&as=mod', size: [1280, 1000] },
    { name: 'landing-page', url: () => '/', size: [1280, 800] },
    { name: 'admin-sessions', url: () => '/?view=admin&as=owner', size: [1280, 1000] },
    { name: 'admin-branding', url: () => '/?view=admin&as=owner#click=branding', size: [1280, 1100] },
    { name: 'admin-health', url: () => '/?view=admin&as=owner#click=health,runHealth', size: [1280, 800] }
  ];
}

async function main() {
  if (!CHROME) {
    console.error('Google Chrome not found. Set CHROME=/path/to/chrome.');
    process.exit(2);
  }
  const filter = process.argv[2] || '';
  fs.mkdirSync(OUT, { recursive: true });
  const port = 8800 + Math.floor(Math.random() * 100);
  const ctx = await serve(port);

  const capture = async (shot) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-shot-'));
    const file = path.join(OUT, shot.name + '.png');
    await run(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--user-data-dir=' + profile,
      '--lang=' + (shot.lang || 'en-US'),
      '--window-size=' + shot.size.join(','),
      '--force-device-scale-factor=' + (shot.scale || 1),
      '--virtual-time-budget=8000',
      '--screenshot=' + file,
      'http://127.0.0.1:' + port + shot.url()
    ], { timeout: 180000 });
    fs.rmSync(profile, { recursive: true, force: true });
    if (shot.crop && process.platform === 'darwin') {
      const scale = shot.scale || 1;
      // sips crops around the center; /phone centers the frame to match.
      await run('sips', ['--cropToHeightWidth', String(shot.crop[1] * scale), String(shot.crop[0] * scale), file], { timeout: 30000 });
    }
    console.log('  ' + path.relative(process.cwd(), file));
  };

  try {
    const selected = shots(ctx).filter((shot) =>
      (!filter || shot.name.indexOf(filter) !== -1) && (!shot.check || filter || process.env.ALL));
    // The plain room screen needs "Now answering" cleared, so it goes first on its own.
    // Every other shot shows the demo with a topic being answered, four at a time.
    const plain = selected.filter((shot) => shot.name === 'room-screen');
    for (const shot of plain) { shot.before(); await capture(shot); }
    selected.forEach((shot) => { if (shot.before && shot.name !== 'room-screen') shot.before(); });
    const queue = selected.filter((shot) => shot.name !== 'room-screen');
    while (queue.length) await Promise.all(queue.splice(0, 4).map(capture));
  } finally {
    ctx.server.close();
  }
}

main();
