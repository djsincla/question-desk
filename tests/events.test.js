'use strict';
/** Events: a parent for sessions, with branding between the site's and the session's; archiving. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

function fakeLogo(fill) {
  return 'data:image/png;base64,' + fill.repeat(200);
}

test('an admin creates, renames, reorders and deletes events; sessions join and leave them', () => {
  const h = createApp().install({ moderators: [MOD] });
  let state = h.app.saveEvent({ name: 'Spring Conference' });
  const spring = state.savedEventId;
  state = h.app.saveEvent({ name: 'Family Night' });
  const family = state.savedEventId;
  assert.deepEqual(state.events.map((e) => e.name), ['Family Night', 'Spring Conference'], 'new events first');

  h.app.saveSession({ name: 'Keynote Q&A', eventId: spring });
  h.app.saveSession({ name: 'Breakout A', eventId: spring });
  h.app.saveSession({ name: 'Standalone' });
  const byName = () => Object.fromEntries(h.app.adminState().sessions.map((s) => [s.name, s]));
  assert.equal(byName()['Keynote Q&A'].eventId, spring);
  assert.equal(byName().Standalone.eventId, undefined);

  // Editing without mentioning the event keeps it; '' removes it; unknown events are refused.
  const keynote = byName()['Keynote Q&A'];
  h.app.saveSession({ id: keynote.id, name: 'Keynote questions' });
  assert.equal(byName()['Keynote questions'].eventId, spring);
  h.app.saveSession({ id: keynote.id, name: 'Keynote questions', eventId: family });
  assert.equal(byName()['Keynote questions'].eventId, family);
  assert.throws(() => h.app.saveSession({ name: 'Orphan', eventId: 'ffffffff' }), /no longer exists/);

  h.app.saveEvent({ id: spring, name: 'Spring Conference 2027' });
  assert.equal(h.app.getEvent_(spring).name, 'Spring Conference 2027');
  state = h.app.reorderEvents([spring, family]);
  assert.deepEqual(state.events.map((e) => e.id), [spring, family]);

  assert.throws(() => h.app.deleteEvent(spring, 'wrong'), /Type the event name/);
  state = h.app.deleteEvent(spring, 'spring conference 2027');
  assert.deepEqual(state.events.map((e) => e.id), [family]);
  assert.equal(byName()['Breakout A'].eventId, undefined, 'sessions are kept and leave the deleted event');

  h.as(MOD);
  assert.throws(() => h.app.saveEvent({ name: 'Nope' }), /Only administrators/);
  assert.throws(() => h.app.deleteEvent(family, 'Family Night'), /Only administrators/);
});

test('event branding overrides the site; session branding overrides the event', () => {
  const h = createApp().install();
  h.app.saveBrand({ orgName: 'Autism Society', accent: '#111111', welcome: 'Welcome all', footer: 'site footer' });
  h.app.saveLogo(fakeLogo('S'));
  const eid = h.app.saveEvent({ name: 'Partner Day', orgName: 'Partner Org', accent: '#222222', welcome: 'Partner welcome',
                                roomBgDark: '#000011' }).savedEventId;
  h.app.saveEventLogo(eid, fakeLogo('E'));

  const plain = h.session({ name: 'Plain' });
  const inEvent = h.session({ name: 'In event', eventId: eid });
  const own = h.session({ name: 'Own brand', eventId: eid, brandAccent: '#333333' });
  h.app.saveLogo(fakeLogo('O'), own.id);

  const b = (s) => h.app.brand_(h.app.getSession_(s.id));
  assert.equal(b(plain).orgName, 'Autism Society');
  assert.equal(b(plain).logo, fakeLogo('S'));

  const ev = b(inEvent);
  assert.equal(ev.orgName, 'Partner Org');
  assert.equal(ev.accent, '#222222');
  assert.equal(ev.welcome, 'Partner welcome');
  assert.equal(ev.footer, 'site footer', 'blank event fields inherit the site');
  assert.equal(ev.roomBgDark, '#000011');
  assert.equal(ev.logo, fakeLogo('E'));
  assert.equal(ev.eventName, 'Partner Day');

  const mine = b(own);
  assert.equal(mine.accent, '#333333');
  assert.equal(mine.orgName, 'Partner Org');
  assert.equal(mine.logo, fakeLogo('O'));

  h.app.removeEventLogo(eid);
  assert.equal(b(inEvent).logo, fakeLogo('S'));
  assert.throws(() => h.app.saveEvent({ id: eid, name: 'Partner Day', accent: 'red' }), /color like/);

  // The participant page gets the event's branding.
  h.app.setSessionActive(inEvent.id, true);
  h.anonymous();
  const page = h.app.doGet({ parameter: { s: inEvent.id, k: h.app.getSession_(inEvent.id).linkKey } });
  assert.equal(page.data.brand.orgName, 'Partner Org');
});

test('queue, landing page, picker and summary email name the event', () => {
  const h = createApp().install({ summaryTo: [MOD], moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Spring Conference' }).savedEventId;
  const s = h.session({ name: 'Keynote', access: 'link', active: true, moderators: [MOD], eventId: eid, emailOnEnd: true });
  h.ask(s, h.join(s), 'Parking is a problem');
  h.as(MOD);
  assert.equal(h.app.getBoard(s.id).session.eventName, 'Spring Conference');
  assert.equal(h.app.mySessions()[0].eventName, 'Spring Conference');
  assert.equal(h.app.doGet({ parameter: {} }).data.sessions[0].eventName, 'Spring Conference');
  assert.equal(h.app.doGet({ parameter: { view: 'moderate' } }).data.links[0].label, 'Spring Conference — Keynote');
  h.as(h.env.owner);
  h.app.endSession(s.id, 'Keynote');
  assert.match(h.env.outbox[0].subject, /^Spring Conference: Keynote — questions summary$/);
});

test('ended sessions are archived out of Script Properties after 30 days, and can be restored', () => {
  const h = createApp().install({ moderators: [MOD] });
  const eid = h.app.saveEvent({ name: 'Old Event' }).savedEventId;
  const s = h.session({ name: 'Old session', access: 'link', active: true, moderators: [MOD], eventId: eid });
  const live = h.session({ name: 'Still running', access: 'link', active: true });
  h.ask(s, h.join(s), 'Parking is a problem');
  h.app.endSession(s.id, 'Old session');
  assert.throws(() => h.app.archiveSession(live.id), /Only ended sessions/);

  h.anonymous();
  h.advance(29 * 24 * 3600);
  h.app.clusterAll_();
  assert.ok(h.app.getSession_(s.id), 'not yet');
  h.advance(2 * 24 * 3600);
  h.app.clusterAll_();
  assert.equal(h.app.getSession_(s.id), null, 'moved out of Script Properties');
  assert.equal(h.props.getProperty('SESSION_' + s.id), null);
  assert.ok(h.app.getSession_(live.id), 'running sessions are never archived');

  h.as(h.env.owner);
  let state = h.app.adminState();
  assert.deepEqual(state.archived.map((a) => [a.id, a.name, a.eventId]), [[s.id, 'Old session', eid]]);
  assert.equal(state.sessions.some((x) => x.id === s.id), false);
  assert.equal(h.questions().rows.filter((r) => r[8] === s.id).length, 1, 'questions stay in the sheet');

  state = h.app.restoreSession(s.id);
  assert.equal(state.archived.length, 0);
  assert.equal(h.app.getSession_(s.id).name, 'Old session');
  assert.equal(h.app.getSession_(s.id).eventId, eid);

  // Manual archive, then restore after its event was deleted: it comes back without the event.
  h.app.archiveSession(s.id);
  h.app.deleteEvent(eid, 'Old Event');
  h.app.restoreSession(s.id);
  assert.equal(h.app.getSession_(s.id).eventId, undefined);

  h.as(MOD);
  assert.throws(() => h.app.archiveSession(s.id), /Only administrators/);
  assert.throws(() => h.app.restoreSession(s.id), /Only administrators/);
});

test('a summary still owed is not archived', () => {
  const h = createApp().install({ summaryTo: [MOD], moderators: [MOD] });
  const s = h.session({ name: 'Owed', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  h.env.mailQuota = 0;
  h.app.endSession(s.id, 'Owed');
  h.anonymous();
  h.advance(40 * 24 * 3600);
  h.app.clusterAll_();
  assert.ok(h.app.getSession_(s.id));
});
