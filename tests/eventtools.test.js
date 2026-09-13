'use strict';
/** Event tools: event-level QA Facilitators, duplicating, the day-of checklist, event summary, QR sheets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, OWNER } = require('./harness');

const MOD = 'mod@example.org';
const MOD2 = 'mod2@example.org';

test('QA Facilitators assigned to an event run every session in it and get its summaries', () => {
  const h = createApp().install({ moderators: [MOD, MOD2] });
  const eid = h.app.saveEvent({ name: 'Conference', moderators: [MOD, 'stranger@example.org'] }).savedEventId;
  assert.deepEqual(h.app.getEvent_(eid).moderators, [MOD], 'only people on the QA Facilitator list');
  const a = h.session({ name: 'Room A', access: 'link', active: true, eventId: eid, moderators: [MOD2], emailOnEnd: true });
  const b = h.session({ name: 'Room B', access: 'link', active: true, eventId: eid });
  const other = h.session({ name: 'Elsewhere', access: 'link', active: true });

  h.as(MOD);
  assert.ok(h.app.getBoard(a.id));
  assert.ok(h.app.getBoard(b.id));
  assert.throws(() => h.app.getBoard(other.id), /not a QA Facilitator/);
  assert.deepEqual(h.app.mySessions().map((s) => s.name).sort(), ['Room A', 'Room B']);

  h.as(OWNER);
  assert.deepEqual(h.app.adminState().sessions.find((s) => s.id === a.id).summaryTo, [MOD2, MOD]);
  h.app.emailLinks(b.id, { toModerators: true, present: true, moderate: true });
  assert.deepEqual(h.env.outbox.map((m) => m.to), [MOD]);

  // Editing the event without mentioning facilitators keeps them; removing the person clears them everywhere.
  h.app.saveEvent({ id: eid, name: 'Conference renamed' });
  assert.deepEqual(h.app.getEvent_(eid).moderators, [MOD]);
  h.app.removePerson('moderator', MOD);
  assert.deepEqual(h.app.getEvent_(eid).moderators, []);
});

test('duplicating a session copies its settings and prepared questions, not its schedule, links or questions', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Monthly meeting' }).savedEventId;
  const start = h.env.clock.now + 24 * 3600 * 1000;
  h.app.saveSession({ name: 'October Q&A', heading: 'Ask us', access: 'link', theme: 'light', cooldownSeconds: 45, eventId: eid,
    moderators: [MOD], emailOnEnd: true, scheduledStart: start, scheduledEnd: start + 3600000, brandOrgName: 'Partner',
    prepared: ['A prepared question to reuse'] });
  const src = h.app.adminState().sessions[0];
  h.app.setSessionActive(src.id, true);
  h.ask(h.app.getSession_(src.id), h.join(h.app.getSession_(src.id)), 'A real question');

  const state = h.app.duplicateSession(src.id);
  const copy = state.sessions.find((s) => s.id === state.newSessionId);
  assert.equal(copy.name, 'October Q&A (copy)');
  ['heading', 'access', 'theme', 'cooldownSeconds', 'eventId', 'moderators', 'emailOnEnd', 'brand'].forEach((k) => assert.deepEqual(copy[k], src[k], k));
  assert.equal(copy.status, 'inactive');
  assert.equal(copy.scheduledStart, null);
  assert.equal(copy.scheduledEnd, null);
  assert.notEqual(copy.linkKey, h.app.getSession_(src.id).linkKey);
  assert.notEqual(copy.screenKey, h.app.getSession_(src.id).screenKey);
  assert.deepEqual(copy.prepared, ['A prepared question to reuse']);
  assert.equal(copy.questionCount, 0);
});

test('duplicating an event copies its branding, languages, logo, facilitators and all its sessions, in order', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Fall Conference', orgName: 'Partner', accent: '#123456', languages: ['vi'], moderators: [MOD] }).savedEventId;
  h.app.saveEventLogo(eid, 'data:image/png;base64,' + 'E'.repeat(400));
  h.app.saveSession({ name: 'Keynote', eventId: eid });
  h.app.saveSession({ name: 'Breakout', eventId: eid });
  h.app.saveSession({ name: 'Elsewhere' });
  const order = h.app.adminState().sessions.filter((s) => s.eventId === eid).map((s) => s.name);

  const state = h.app.duplicateEvent(eid);
  const copy = h.app.getEvent_(state.savedEventId);
  assert.equal(copy.name, 'Fall Conference (copy)');
  assert.deepEqual(copy.brand, h.app.getEvent_(eid).brand);
  assert.deepEqual(copy.languages, ['en', 'vi']);
  assert.deepEqual(copy.moderators, [MOD]);
  assert.equal(h.app.getEventLogo(copy.id), 'data:image/png;base64,' + 'E'.repeat(400));
  const copies = state.sessions.filter((s) => s.eventId === copy.id);
  assert.deepEqual(copies.map((s) => s.name), order, 'same names, same order');
  assert.equal(state.sessions.filter((s) => s.eventId === eid).length, 2, 'the original is untouched');
});

test('the day-of checklist flags what isn\'t ready, per session', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.setUp();
  const eid = h.app.saveEvent({ name: 'Tonight' }).savedEventId;
  const soon = h.env.clock.now + 3600 * 1000;
  h.app.saveSession({ name: 'Ready', eventId: eid, moderators: [MOD], emailOnEnd: true, scheduledStart: soon, scheduledEnd: soon + 3600000,
    guestPage: { room: true, slide: true } });
  h.app.saveSession({ name: 'Not ready', eventId: eid, emailOnEnd: true });
  h.app.saveSummaryDefaults({ facilitators: true, extra: [] });

  const res = h.app.eventChecklist(eid);
  assert.equal(res.event.name, 'Tonight');
  assert.ok(res.site.find((c) => /every minute/.test(c.label)).ok);
  const by = Object.fromEntries(res.sessions.map((s) => [s.name, Object.fromEntries(s.checks.map((c) => [c.label, c]))]));
  assert.equal(by.Ready['Starts on its own'].ok, true);
  assert.equal(by.Ready['QA Facilitators'].ok, true);
  assert.equal(by.Ready['Summary email'].ok, true);
  assert.equal(by.Ready['Guest page'].ok, true);
  assert.equal(by['Not ready']['Not active'].ok, null);
  assert.equal(by['Not ready']['QA Facilitators'].ok, false);
  assert.equal(by['Not ready']['Summary email'].ok, false, 'on, but nobody would get it');
  assert.match(res.sessions[0].links.present, /view=present/);
  h.as(MOD);
  assert.throws(() => h.app.eventChecklist(eid), /Only administrators/);
});

test('one summary email for a whole event, with every session and a single CSV', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Conference' }).savedEventId;
  const a = h.session({ name: 'Room A', access: 'link', active: true, eventId: eid, moderators: [MOD] });
  const b = h.session({ name: 'Room B', access: 'link', active: true, eventId: eid, moderators: [MOD] });
  h.ask(a, h.join(a), 'Parking at room A');
  h.ask(b, h.join(b), 'Funding at room B');
  h.app.clusterAll_();

  assert.equal(h.app.emailEventSummary(eid, []), 1, 'defaults to the sessions\' recipients');
  const mail = h.env.outbox[0];
  assert.equal(mail.to, MOD);
  assert.equal(mail.subject, 'Conference — questions summary for the whole event');
  // Sessions appear in the order the Admin page lists them.
  const listed = h.app.adminState().sessions.map((x) => x.name);
  const [first, second] = listed;
  assert.match(mail.htmlBody, new RegExp(first + '[\\s\\S]*' + second));
  assert.match(mail.htmlBody, /Room A<\/h1>[\s\S]*Parking at room A/);
  assert.match(mail.htmlBody, /Room B<\/h1>[\s\S]*Funding at room B/);
  assert.match(mail.htmlBody, /2 sessions · 2 questions/);
  const csv = h.app.parseCsv_(mail.attachments[0].getDataAsString());
  assert.equal(csv[0][0], 'Session');
  assert.deepEqual(csv.slice(1).map((r) => [r[0], r[6]]).sort(), [['Room A', 'Parking at room A'], ['Room B', 'Funding at room B']]);
  assert.equal(mail.attachments[0].name, 'Conference-questions.csv');

  h.app.emailEventSummary(eid, ['board@partner.test']);
  assert.equal(h.env.outbox[1].to, 'board@partner.test');
  assert.ok(!h.app.getSession_(a.id).summarySent, 'an event summary doesn\'t count as the session\'s own summary');
});

test('QR sheets are for administrators and include only shareable-link sessions', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Conference', languages: ['es'] }).savedEventId;
  h.session({ name: 'Link one', access: 'link', eventId: eid, heading: 'Ask the panel' });
  h.session({ name: 'Room one', access: 'room', eventId: eid });
  const page = h.app.doGet({ parameter: { view: 'qrsheet', e: eid } });
  assert.equal(page.file, 'Sheet.html');
  assert.equal(page.data.eventName, 'Conference');
  assert.deepEqual(page.data.languages, ['en', 'es']);
  const byName = Object.fromEntries(page.data.sessions.map((s) => [s.name, s]));
  assert.match(byName['Link one'].url, /\?s=[a-f0-9]{8}&k=[a-f0-9]{16}$/);
  assert.equal(byName['Room one'].url, '');
  h.as(MOD);
  assert.equal(h.app.doGet({ parameter: { view: 'qrsheet', e: eid } }).file, 'Denied.html');
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'qrsheet', e: eid } }).file, 'Denied.html');
});
