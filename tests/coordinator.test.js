'use strict';
/** Event Coordinators: the role, the event they are assigned to, and their portal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';
const COORD = 'coord@example.org';
const OTHER = 'other@example.org';

/** An event with two sessions, some logistics questions and some not. */
function eventWithQuestions(options) {
  const h = createApp().install({ moderators: [MOD] });
  h.app.addPerson('coordinator', COORD);
  if (options && options.second) h.app.addPerson('coordinator', OTHER);
  const eid = h.app.saveEvent({ name: 'Fall Conference', coordinators: [COORD] }).savedEventId;
  const one = h.session({ name: 'Keynote', room: 'Ballroom A', access: 'link', eventId: eid, active: true, moderators: [MOD] });
  const two = h.session({ name: 'Workshop', room: 'Room 201', access: 'link', eventId: eid, active: true, moderators: [MOD] });
  h.ask(one, h.join(one), 'Where is the parking for this building?');
  h.ask(one, h.join(one), 'What does the new funding mean for families?');
  h.ask(two, h.join(two), 'Is there a quiet room for people who need a break?');
  h.app.clusterAll_();
  return { h, eid, one, two };
}

test('Event Coordinator is a role of its own, added and removed on the People tab', () => {
  const h = createApp().install();
  h.app.addPerson('coordinator', COORD);
  const state = h.app.adminState();
  assert.deepEqual(state.coordinators, [COORD]);
  assert.deepEqual(state.moderators, [], 'not a QA Facilitator');
  assert.ok(h.app.getActivity().entries.some((e) => e.action === 'Event Coordinator added'));

  const eid = h.app.saveEvent({ name: 'Fall Conference', coordinators: [COORD] }).savedEventId;
  assert.deepEqual(h.app.getEvent_(eid).coordinators, [COORD]);

  h.app.removePerson('coordinator', COORD);
  assert.deepEqual(h.app.adminState().coordinators, []);
  assert.deepEqual(h.app.getEvent_(eid).coordinators, [], 'and taken off every event');
  assert.ok(h.app.getActivity().entries.some((e) => e.action === 'Event Coordinator removed'));
});

test('only people holding the role can be named on an event', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.addPerson('coordinator', COORD);
  const eid = h.app.saveEvent({ name: 'Fall Conference', coordinators: [COORD, MOD, 'nobody@example.org'] }).savedEventId;
  assert.deepEqual(h.app.getEvent_(eid).coordinators, [COORD], 'a QA Facilitator is not one by accident');
  h.app.saveEvent({ id: eid, name: 'Fall Conference' });
  assert.deepEqual(h.app.getEvent_(eid).coordinators, [COORD], 'an edit that does not mention them changes nothing');
});

test('Gemini marks the questions about running the event, and the queue flags them', () => {
  const { h, one } = eventWithQuestions();
  const asked = h.app.sessionRows_(one.id);
  const parking = asked.find((q) => /parking/.test(q.text));
  const funding = asked.find((q) => /funding/.test(q.text));
  assert.equal(parking.logistics, true);
  assert.equal(funding.logistics, false, 'a question about the subject is not logistics');

  // The facilitator still has it, flagged, so nothing is quietly taken away from the session.
  h.as(MOD);
  const board = h.app.getBoard(one.id);
  const row = board.topics.concat([{ questions: board.unsorted }])
    .reduce((all, t) => all.concat(t.questions), []).find((q) => /parking/.test(q.text));
  assert.equal(row.logistics, true);
  assert.equal(row.sorted, false);
});

test('the portal gathers one event\'s logistics questions from every session', () => {
  const { h, eid } = eventWithQuestions();
  h.as(COORD);
  const board = h.app.getCoordinatorBoard(eid);
  assert.equal(board.event.name, 'Fall Conference');
  assert.deepEqual(board.questions.map((q) => q.text).sort(),
    ['Is there a quiet room for people who need a break?', 'Where is the parking for this building?']);
  assert.deepEqual(board.questions.map((q) => q.session).sort(), ['Keynote', 'Workshop']);
  assert.equal(board.questions.find((q) => /parking/.test(q.text)).room, 'Ballroom A', 'where to go');
  assert.equal(board.waiting, 2);
  assert.deepEqual(board.sessions.map((s) => s.name).sort(), ['Keynote', 'Workshop']);
  assert.equal(board.isAdmin, false);
});

test('a coordinator ticks one off, and grouping never puts it back', () => {
  const { h, eid, one } = eventWithQuestions();
  h.as(COORD);
  const parking = h.app.getCoordinatorBoard(eid).questions.find((q) => /parking/.test(q.text));
  const after = h.app.setLogisticsSorted(eid, parking.id, true);
  assert.equal(after.waiting, 1);
  assert.equal(after.questions.find((q) => q.id === parking.id).sorted, true);
  assert.equal(after.questions[after.questions.length - 1].id, parking.id, 'sorted ones sink');

  h.app.clusterAll_();   // a later grouping run must not undo it
  h.as(COORD);
  assert.equal(h.app.getCoordinatorBoard(eid).questions.find((q) => q.id === parking.id).sorted, true);

  // The facilitator sees that it was dealt with.
  h.as(MOD);
  const rows = h.app.getBoard(one.id).topics.reduce((all, t) => all.concat(t.questions), [])
    .concat(h.app.getBoard(one.id).unsorted);
  assert.equal(rows.find((q) => q.id === parking.id).sorted, true);

  h.as(COORD);
  assert.equal(h.app.setLogisticsSorted(eid, parking.id, false).waiting, 2, 'and can be put back');
  h.as(h.env.owner);
  assert.ok(h.app.getActivity({}).entries.some((e) => e.action === 'Logistics question sorted'));
});

test('a portal is one event\'s, and only for the people assigned to it', () => {
  const { h, eid } = eventWithQuestions({ second: true });
  const otherEid = h.app.saveEvent({ name: 'Spring Day', coordinators: [OTHER] }).savedEventId;
  const s = h.session({ name: 'Elsewhere', access: 'link', eventId: otherEid, active: true });
  h.ask(s, h.join(s), 'Where do we park at the spring day?');
  h.app.clusterAll_();

  h.as(COORD);
  assert.deepEqual(h.app.getCoordinatorBoard(eid).questions.map((q) => q.session).sort(), ['Keynote', 'Workshop']);
  assert.throws(() => h.app.getCoordinatorBoard(otherEid), /not an Event Coordinator/);
  const theirs = h.app.getCoordinatorBoard(eid).questions[0];
  h.as(OTHER);
  assert.throws(() => h.app.setLogisticsSorted(otherEid, theirs.id, true), /no longer in this event/);

  // A QA Facilitator is not a coordinator; an administrator can always look.
  h.as(MOD);
  assert.throws(() => h.app.getCoordinatorBoard(eid), /not an Event Coordinator/);
  h.as(h.env.owner);
  assert.equal(h.app.getCoordinatorBoard(eid).isAdmin, true);
});

test('the portal page opens for a coordinator, and offers a choice when the link has no event', () => {
  const { h, eid } = eventWithQuestions();
  h.as(COORD);
  const page = h.app.doGet({ parameter: { view: 'coordinator', e: eid } });
  assert.equal(page.data.eid, eid);
  assert.equal(page.data.board.questions.length, 2);
  assert.match(page.file, /Coordinator\.html/);

  const pick = h.app.doGet({ parameter: { view: 'coordinator' } });
  assert.match(pick.file, /Denied\.html/);
  assert.equal(pick.data.heading, 'Choose an event');
  assert.deepEqual(pick.data.links.map((l) => l.label), ['Fall Conference']);

  // Someone without the role gets the same answer as any other staff page.
  h.as(MOD);
  assert.equal(h.app.doGet({ parameter: { view: 'coordinator', e: eid } }).data.heading, 'This view is for QA Facilitators');
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { view: 'coordinator', e: eid } }).data.heading, 'This view is for QA Facilitators');
});
