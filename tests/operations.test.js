'use strict';
/** Schedules, health checks and alerts, load testing, deletion, and setUp safety. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';
const MINUTE = 60;

// ------------------------------------------------------------ schedule

test('a scheduled session starts at its start time, not before', () => {
  const h = createApp().install();
  const now = h.env.clock.now;
  const s = h.session({ name: 'Scheduled', scheduledStart: now + 10 * MINUTE * 1000 });
  h.app.clusterQuestions();
  assert.equal(h.app.getSession_(s.id).status, 'inactive');
  h.advance(10 * MINUTE);
  h.app.clusterQuestions();
  const started = h.app.getSession_(s.id);
  assert.equal(started.status, 'active');
  assert.equal(started.scheduleStarted, true);
});

test('the schedule starts a session only once, so a manual deactivate sticks', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Once', scheduledStart: h.env.clock.now + 1000 });
  h.advance(2);
  h.app.clusterQuestions();
  h.app.setSessionActive(s.id, false);
  h.advance(MINUTE);
  h.app.clusterQuestions();
  assert.equal(h.app.getSession_(s.id).status, 'inactive');
});

test('changing the start time re-arms the schedule', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Rearm', scheduledStart: h.env.clock.now + 1000 });
  h.advance(2);
  h.app.clusterQuestions();
  h.app.setSessionActive(s.id, false);
  h.app.saveSession({ id: s.id, name: 'Rearm', scheduledStart: h.env.clock.now + 5 * MINUTE * 1000 });
  h.advance(5 * MINUTE + 1);
  h.app.clusterQuestions();
  assert.equal(h.app.getSession_(s.id).status, 'active');
});

test('a scheduled end ends the session and sends the summary', () => {
  const h = createApp().install({ moderators: [MOD] });
  const now = h.env.clock.now;
  const s = h.session({ name: 'Ends itself', access: 'link', moderators: [MOD], emailOnEnd: true,
                        scheduledStart: now + 1000, scheduledEnd: now + 60 * MINUTE * 1000 });
  h.advance(2);
  h.app.clusterQuestions();
  h.ask(s, h.join(s), 'Question during the session');
  h.advance(60 * MINUTE);
  h.anonymous();                      // triggers do not run as a signed-in admin
  h.app.clusterQuestions();
  assert.equal(h.app.getSession_(s.id).status, 'ended');
  assert.equal(h.env.outbox.length, 1);
  assert.equal(h.env.outbox[0].to, MOD);
});

test('schedule validation', () => {
  const h = createApp().install();
  const now = h.env.clock.now;
  assert.throws(() => h.app.saveSession({ name: 'x', scheduledStart: now + 2000, scheduledEnd: now + 1000 }), /end must be after the start/);
  assert.throws(() => h.app.saveSession({ name: 'x', scheduledStart: 'tomorrow' }), /not a valid date/);
  assert.doesNotThrow(() => h.app.saveSession({ name: 'x', scheduledStart: '', scheduledEnd: null }));
});

// ------------------------------------------------------------ health

test('health check passes on a healthy install', () => {
  const h = createApp().install();
  const res = h.app.runHealthCheck();
  const failed = res.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, []);
  assert.ok(res.checks.some((c) => /Gemini model gemini-3\.5-flash/.test(c.name)));
});

test('health check explains a retired model, a missing key, and a missing trigger', () => {
  const h = createApp().install();
  h.env.gemini = () => ({ status: 404, text: 'models/gemini-3.5-flash is not found' });
  let checks = h.app.runHealthCheck().checks;
  assert.match(checks.find((c) => /Gemini model/.test(c.name)).detail, /not found; it may have been retired\. Update CONFIG\.model/);

  h.env.triggers = [];
  h.props.deleteProperty('GEMINI_API_KEY');
  checks = h.app.runHealthCheck().checks;
  assert.equal(checks.find((c) => c.name === 'Gemini API key').ok, false);
  assert.equal(checks.find((c) => /trigger/.test(c.name)).ok, false);
});

test('health check is admin only', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.as(MOD);
  assert.throws(() => h.app.runHealthCheck(), /Only administrators/);
});

test('repeated grouping failures email admins once, then again on recovery', () => {
  const h = createApp().install({ admins: ['admin2@example.org'] });
  const s = h.session({ name: 'Alerting', access: 'link', active: true });
  h.ask(s, h.join(s), 'This will not group');
  const working = h.env.gemini;
  h.env.gemini = () => ({ status: 404, text: 'gone' });

  h.anonymous();
  h.app.clusterQuestions();
  h.app.clusterQuestions();
  assert.equal(h.env.outbox.length, 0, 'no alert before the threshold');
  h.app.clusterQuestions();
  assert.equal(h.env.outbox.length, 1);
  assert.equal(h.env.outbox[0].to, 'owner@example.org,admin2@example.org');
  assert.match(h.env.outbox[0].subject, /grouping is failing/);
  assert.match(h.env.outbox[0].htmlBody, /404/);

  h.app.clusterQuestions();
  h.app.clusterQuestions();
  assert.equal(h.env.outbox.length, 1, 'not repeated every minute');

  h.env.gemini = working;
  h.app.clusterQuestions();
  assert.equal(h.env.outbox.length, 2);
  assert.match(h.env.outbox[1].subject, /recovered/);
  assert.equal(JSON.parse(h.props.getProperty('HEALTH')).failures, 0);
});

test('no pending questions means no health noise', () => {
  const h = createApp().install();
  h.session({ name: 'Quiet', active: true });
  h.env.gemini = () => ({ status: 500, text: 'down' });
  for (let i = 0; i < 5; i++) h.app.clusterQuestions();
  assert.equal(h.props.getProperty('HEALTH'), null);
  assert.equal(h.env.geminiCalls.length, 0);
});

// ------------------------------------------------------------ load test

test('the POST endpoint is off unless a load test is running', () => {
  const h = createApp().install();
  assert.equal(h.post({ key: 'anything', text: 'hello there' }).reason, 'disabled');
  assert.equal(h.post('not json').reason, 'badRequest');
  assert.equal(h.questions().rows.length, 1);
});

test('a load test accepts keyed submissions without the room cap, then cleans up', () => {
  const h = createApp().install();
  const keep = h.session({ name: 'Real session', access: 'link', active: true });
  h.ask(keep, h.join(keep), 'A real question to keep');

  const view = h.app.startLoadTest().loadTest;
  assert.match(view.key, /^[a-f0-9]{32}$/);
  assert.match(view.command, /node scripts\/loadtest\.js --url "https:\/\/script\.google\.com\/macros\/s\/DEPLOYID\/exec" --key [a-f0-9]{32}/);
  assert.equal(h.app.startLoadTest().loadTest.key, view.key, 'starting again reuses the running test');

  assert.equal(h.post({ key: 'wrong', text: 'Nope nope' }).reason, 'disabled');
  for (let i = 0; i < 40; i++) {
    const res = h.post({ key: view.key, text: 'Load test question ' + i });
    assert.equal(res.ok, true, 'submission ' + i + ' ' + res.reason);
    assert.equal(typeof res.serverMs, 'number');
  }
  assert.equal(h.post({ key: view.key, text: 'x'.repeat(5000) }).reason, 'tooLong');
  assert.equal(h.questions().rows.length, 42);
  assert.equal(h.app.getSession_(view.sid).loadTest, true);

  h.app.stopLoadTest();
  assert.equal(h.post({ key: view.key, text: 'After stop' }).reason, 'disabled');
  assert.equal(h.app.getSession_(view.sid), null);
  assert.deepEqual(h.questions().rows.slice(1).map((r) => r[3]), ['A real question to keep']);
});

test('the load-test endpoint expires on its own after an hour', () => {
  const h = createApp().install();
  const key = h.app.startLoadTest().loadTest.key;
  h.advance(61 * MINUTE);
  assert.equal(h.post({ key, text: 'Too late now' }).reason, 'disabled');
  assert.equal(h.app.adminState().loadTest.expired, true);
});

test('load test controls are admin only and the room cap still applies to normal submissions', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.as(MOD);
  assert.throws(() => h.app.startLoadTest(), /Only administrators/);
  h.as(h.env.owner);
  const view = h.app.startLoadTest().loadTest;
  const session = h.app.getSession_(view.sid);
  for (let i = 0; i < 15; i++) h.ask(session, h.join(session), 'Normal path ' + i);
  assert.equal(h.ask(session, h.join(session), 'Sixteenth').reason, 'busy', 'google.script.run path keeps the cap');
});

// ------------------------------------------------------------ deletion and safety

test('deleting a session removes its questions, topics, votes and logo only', () => {
  const h = createApp().install();
  const gone = h.session({ name: 'Gone', access: 'link', active: true });
  const kept = h.session({ name: 'Kept', access: 'link', active: true });
  h.ask(gone, h.join(gone), 'Parking in gone');
  h.ask(kept, h.join(kept), 'Parking in kept');
  h.app.clusterQuestions();
  h.app.saveLogo('data:image/png;base64,AAAA', gone.id);

  assert.throws(() => h.app.deleteSession(gone.id), /Deactivate or end/);
  h.app.setSessionActive(gone.id, false);
  h.app.deleteSession(gone.id);

  assert.equal(h.app.getSession_(gone.id), null);
  assert.deepEqual(h.questions().rows.slice(1).map((r) => r[8]), [kept.id]);
  assert.deepEqual(h.topics().rows.slice(1).map((r) => r[0]), [kept.id]);
  assert.equal(h.props.getProperty('VOTES_' + gone.id), null);
  assert.equal(h.assets().rows.filter((r) => r[0] === gone.id).length, 0);
});

test('grouping writes land on the right rows even if rows move while Gemini is working', () => {
  const h = createApp().install();
  const doomed = h.session({ name: 'Doomed', access: 'link', active: true });
  const live = h.session({ name: 'Live', access: 'link', active: true });
  h.ask(doomed, h.join(doomed), 'Delete me first');
  h.ask(live, h.join(live), 'Parking matters');

  const normal = h.env.gemini;
  h.env.gemini = (call) => {
    // Simulate another execution deleting an earlier row mid-call.
    if (/Parking matters/.test(call.prompt)) h.questions().rows.splice(1, 1);
    return normal(call);
  };
  h.app.groupNow(live.id);
  const row = h.questions().rows.find((r) => r[3] === 'Parking matters');
  assert.equal(row[5], 'About parking');
});

test('setUp cannot be run by anonymous visitors or moderators', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.anonymous();
  assert.throws(() => h.app.setUp(), /script owner/);
  h.as(MOD);
  assert.throws(() => h.app.setUp(), /script owner/);
});
