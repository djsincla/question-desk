'use strict';
/** Sessions CSV: export, check, import, and duplicate matching by name + start + end. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';
const MOD2 = 'mod2@example.org';

function parse(csv) {
  const app = createApp().install().app;
  return app.parseCsv_(csv);
}

test('export writes every session setting in the app time zone, and parses back', () => {
  const h = createApp().install({ moderators: [MOD, MOD2] });
  const eid = h.app.saveEvent({ name: 'Fall Conference' }).savedEventId;
  const start = Date.UTC(2026, 9, 4, 1, 30);   // 2026-10-03 18:30 in Los Angeles
  h.app.saveSession({
    name: 'Keynote, "Main" hall', heading: 'Ask the panel', access: 'link', theme: 'light', eventId: eid,
    cooldownSeconds: 45, maxLength: 250, emailOnEnd: true, moderators: [MOD, MOD2],
    scheduledStart: start, scheduledEnd: start + 2 * 3600 * 1000,
    summary: { mode: 'custom', facilitators: false, extra: 'board@partner.test' },
    guestPage: { room: true, slide: false, url: '' }, brandOrgName: 'Partner', brandAccent: '#123456',
    prepared: ['What is next for teens?', 'How do we give feedback?']
  });
  h.app.saveSession({ name: '-starts with a dash' });

  const out = h.app.exportSessionsCsv();
  assert.equal(out.count, 2);
  assert.match(out.filename, /^question-desk-sessions-\d{4}-\d{2}-\d{2}\.csv$/);
  const rows = h.app.parseCsv_(out.csv);
  assert.equal(rows[0][8], 'Scheduled start (America/Los_Angeles)');
  const byName = Object.fromEntries(rows.slice(1).map((r) => [r[1], r]));
  const k = byName['Keynote, "Main" hall'];
  assert.deepEqual(k, ['Fall Conference', 'Keynote, "Main" hall', 'Ask the panel', 'link', 'light', '45', '250', 'yes',
    '2026-10-03 18:30', '2026-10-03 20:30', MOD + '; ' + MOD2, 'custom', 'no', 'board@partner.test', 'yes', 'no', '',
    'Partner', '#123456', 'What is next for teens?\nHow do we give feedback?', 'yes', 'inactive']);
  assert.equal(byName["'-starts with a dash"][1], "'-starts with a dash", 'formula guard on export');

  h.as(MOD);
  assert.throws(() => h.app.exportSessionsCsv(), /Only administrators/);
  assert.throws(() => h.app.importSessionsCsv(out.csv, {}, true), /Only administrators/);
});

test('an exported file imports into a fresh install as the same sessions and events', () => {
  const a = createApp().install({ moderators: [MOD] });
  const eid = a.app.saveEvent({ name: 'Fall Conference' }).savedEventId;
  const start = Date.UTC(2026, 9, 4, 1, 30);
  a.app.saveSession({ name: 'Keynote', access: 'link', eventId: eid, moderators: [MOD], scheduledStart: start, scheduledEnd: start + 3600000,
    cooldownSeconds: 0, prepared: ['First prepared question'], guestPage: { room: false, slide: true } });
  a.app.saveSession({ name: 'Breakout', theme: 'light' });
  const csv = a.app.exportSessionsCsv().csv;

  const b = createApp().install({ moderators: [MOD] });
  const exportedOrder = a.app.adminState().sessions.map((x) => x.name);
  const check = b.app.importSessionsCsv(csv, {}, true);
  assert.deepEqual(check.rows.map((r) => [r.name, r.action]), exportedOrder.map((name) => [name, 'create']));
  assert.deepEqual(check.events, ['Fall Conference']);
  assert.equal(b.app.adminState().sessions.length, 0, 'checking saves nothing');
  assert.equal(b.app.adminState().events.length, 0);

  const done = b.app.importSessionsCsv(csv, {}, false);
  assert.equal(done.created, 2);
  assert.equal(done.failed, 0);
  assert.deepEqual(b.app.adminState().sessions.map((x) => x.name), exportedOrder, 'same order as the file');
  const s = Object.fromEntries(b.app.adminState().sessions.map((x) => [x.name, x]));
  assert.equal(b.app.getEvent_(s.Keynote.eventId).name, 'Fall Conference');
  assert.equal(s.Keynote.access, 'link');
  assert.equal(s.Keynote.scheduledStart, start);
  assert.equal(s.Keynote.cooldownSeconds, 0);
  assert.deepEqual(s.Keynote.moderators, [MOD]);
  assert.deepEqual(s.Keynote.prepared, ['First prepared question']);
  assert.deepEqual(s.Keynote.guestPage, { room: false, slide: true, url: '' });
  assert.equal(s.Breakout.theme, 'light');
  assert.equal(s.Breakout.eventId, undefined);
});

test('duplicates match on name + start + end, or name alone without times; update or skip', () => {
  const h = createApp().install({ moderators: [MOD] });
  const start = Date.UTC(2026, 9, 4, 1, 30);
  h.app.saveSession({ name: 'Keynote', scheduledStart: start, scheduledEnd: start + 3600000, maxLength: 300 });
  h.app.saveSession({ name: 'Open Mic', maxLength: 300 });
  const ids = Object.fromEntries(h.app.adminState().sessions.map((x) => [x.name, x.id]));

  const csv = [
    'Session,Scheduled start,Scheduled end,Longest question (characters)',
    'keynote ,2026-10-03 18:30,2026-10-03 19:30,400',           // same name (case/spacing forgiven) and times: duplicate
    'Keynote,2026-10-10 18:30,2026-10-10 19:30,400',            // same name, other day: a new session
    'Open Mic,,,500',                                            // no times: matched by name
    'Open Mic,2026-11-01 10:00,,500'                             // a start time makes it a different session
  ].join('\n');

  const check = h.app.importSessionsCsv(csv, { duplicates: 'update' }, true);
  assert.deepEqual(check.rows.map((r) => r.action), ['update', 'create', 'update', 'create']);

  const skip = h.app.importSessionsCsv(csv, { duplicates: 'skip' }, true);
  assert.deepEqual(skip.rows.map((r) => r.action), ['skip', 'create', 'skip', 'create']);

  const done = h.app.importSessionsCsv(csv, { duplicates: 'update' }, false);
  assert.deepEqual([done.created, done.updated, done.failed], [2, 2, 0]);
  assert.equal(h.app.getSession_(ids.Keynote).maxLength, 400);
  assert.equal(h.app.getSession_(ids.Keynote).name, 'keynote', 'the file\'s name is kept');
  assert.equal(h.app.getSession_(ids['Open Mic']).maxLength, 500);
  assert.equal(h.app.adminState().sessions.length, 4);

  // Stored times with seconds still match the minute shown in the file.
  h.app.updateSession_(ids.Keynote, (x) => { x.scheduledStart += 42000; });
  assert.equal(h.app.importSessionsCsv(csv, {}, true).rows[0].action, 'update');

  // Importing the same file again changes nothing new: every row is now a duplicate.
  const again = h.app.importSessionsCsv(csv, {}, true);
  assert.deepEqual(again.rows.map((r) => r.action), ['update', 'update', 'update', 'update']);
});

test('updates only change the columns in the file', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.saveSession({ name: 'Partial', access: 'link', theme: 'light', cooldownSeconds: 30, moderators: [MOD], brandOrgName: 'Kept',
    prepared: ['Keep me please'] });
  const before = h.app.adminState().sessions[0];
  h.app.importSessionsCsv('Session,Heading participants see\nPartial,New heading', {}, false);
  const after = h.app.adminState().sessions[0];
  assert.equal(after.heading, 'New heading');
  ['access', 'theme', 'cooldownSeconds', 'moderators', 'brand', 'linkKey', 'screenKey', 'prepared'].forEach((k) => {
    assert.deepEqual(after[k], before[k], k + ' unchanged');
  });
});

test('bad rows are reported with their row number and never saved; good rows still import', () => {
  const h = createApp().install({ moderators: [MOD] });
  const csv = [
    'Event,Session,How people join (room or link),Scheduled start,Scheduled end,QA Facilitators,Email summary when ended (yes or no),Session accent color',
    ',Good one,link,10/3/2026 6:30 PM,10/3/2026 8:00 PM,' + MOD + '; stranger@example.org,yes,',
    ',,room,,,,,',
    ',Bad join,everyone,,,,,',
    ',Bad time,room,tomorrow evening,,,,',
    ',Backwards,room,2026-10-03 18:30,2026-10-03 17:00,,,',
    ',Past end,room,,2026-01-01 10:00,,,',
    ',Bad yes,room,,,,perhaps,',
    ',Bad color,room,,,,,blue',
    ',Good one,link,2026-10-03 18:30,2026-10-03 20:00,,,',
    'New Event,Evented,room,,,,,'
  ].join('\r\n');
  const check = h.app.importSessionsCsv(csv, {}, true);
  const byRow = Object.fromEntries(check.rows.map((r) => [r.row, r]));
  assert.equal(byRow[2].action, 'create');
  assert.match(byRow[2].warnings.join(' '), /stranger@example\.org/);
  assert.match(byRow[3].errors[0], /No session name/);
  assert.match(byRow[4].errors[0], /room or link/);
  assert.match(byRow[5].errors[0], /not a date and time/);
  assert.match(byRow[6].errors[0], /end must be after the start/);
  assert.match(byRow[7].errors[0], /already passed/);
  assert.match(byRow[8].errors[0], /yes or no/);
  assert.match(byRow[9].errors[0], /accent/);
  assert.match(byRow[10].errors[0], /already on row 2/, '10/3/2026 6:30 PM and 2026-10-03 18:30 are the same time');
  assert.match(byRow[11].warnings.join(' '), /New event "New Event" will be created/);

  const done = h.app.importSessionsCsv(csv, {}, false);
  assert.deepEqual([done.created, done.failed], [2, 8]);
  const s = Object.fromEntries(h.app.adminState().sessions.map((x) => [x.name, x]));
  assert.equal(Object.keys(s).length, 2);
  assert.equal(s['Good one'].scheduledStart, Date.UTC(2026, 9, 4, 1, 30));
  assert.deepEqual(s['Good one'].moderators, [MOD]);
  assert.equal(h.app.getEvent_(s.Evented.eventId).name, 'New Event');
});

test('ended sessions are never changed by an import; limits and missing columns are refused', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Finished', active: true });
  h.app.endSession(s.id, 'Finished');
  const res = h.app.importSessionsCsv('Session,Heading participants see\nFinished,Changed', {}, false);
  assert.equal(res.rows[0].action, 'skip');
  assert.notEqual(h.app.getSession_(s.id).heading, 'Changed');

  assert.throws(() => h.app.importSessionsCsv('Name,Heading\nx,y', {}, true), /needs a "Session" column/);
  assert.throws(() => h.app.importSessionsCsv('', {}, true), /empty/);
  const many = ['Session'].concat(Array.from({ length: 201 }, (_, i) => 'S' + i)).join('\n');
  assert.throws(() => h.app.importSessionsCsv(many, {}, true), /at most 200/);
});

test('CSV parsing handles quotes, commas, line breaks, CRLF and a byte-order mark', () => {
  assert.deepEqual(parse('﻿a,"b, c","say ""hi""","line\nbreak"\r\n1,2,3,4\r\n\r\n'),
    [['a', 'b, c', 'say "hi"', 'line\nbreak'], ['1', '2', '3', '4']]);
});
