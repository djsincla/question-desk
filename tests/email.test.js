'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';
const MOD2 = 'mod2@example.org';

function csvOf(message) {
  return message.attachments[0].getDataAsString();
}

test('ending a session emails its moderators a summary with a CSV', () => {
  const h = createApp().install({ moderators: [MOD, MOD2] });
  h.app.saveBrand({ orgName: 'Example Society' });
  const s = h.session({ name: 'Family night', access: 'link', active: true, moderators: [MOD, MOD2], emailOnEnd: true });
  h.ask(s, h.join(s), 'Parking is a problem');
  h.ask(s, h.join(s), 'Respite hours?');

  const res = h.app.endSession(s.id);
  assert.equal(res.emailed, 2);
  assert.equal(h.env.outbox.length, 1);
  const mail = h.env.outbox[0];
  assert.equal(mail.to, MOD + ',' + MOD2);
  assert.equal(mail.name, 'Example Society');
  assert.match(mail.subject, /Family night — questions summary/);
  assert.match(mail.htmlBody, /2 questions in 2 topics/);
  assert.equal(mail.attachments[0].contentType, 'text/csv');
  assert.equal(mail.attachments[0].name, 'Family-night-questions.csv');
  const csv = csvOf(mail);
  assert.match(csv, /"Parking is a problem"/);
  assert.match(csv, /"About respite"/);
  assert.ok(h.app.getSession_(s.id).summarySent);
});

test('ending runs a final grouping pass so the summary is translated', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Final pass', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  h.ask(s, h.join(s), 'Ungrouped until the end');
  h.env.geminiCalls.length = 0;
  h.app.endSession(s.id);
  assert.equal(h.env.geminiCalls.length, 1);
  assert.doesNotMatch(h.env.outbox[0].htmlBody, /Not grouped/);
});

test('the summary still sends when final grouping fails', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Gemini down', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  h.ask(s, h.join(s), 'Will this still arrive?');
  h.env.gemini = () => ({ status: 503, text: 'unavailable' });
  const res = h.app.endSession(s.id);
  assert.equal(res.emailed, 1);
  assert.match(res.note, /Final grouping failed/);
  assert.match(h.env.outbox[0].htmlBody, /Not grouped/);
});

test('no email when the session does not ask for one', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Quiet', active: true, moderators: [MOD], emailOnEnd: false });
  assert.equal(h.app.endSession(s.id).emailed, 0);
  assert.equal(h.env.outbox.length, 0);
});

test('dismissed questions are counted but left out of the summary body, kept in the CSV', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Dismissed', access: 'link', active: true, moderators: [MOD] });
  h.ask(s, h.join(s), 'Keep this question');
  h.ask(s, h.join(s), 'Spam spam spam');
  h.app.setStatus(s.id, [h.questions().rows[2][0]], 'dismissed');
  h.app.endSession(s.id);
  h.app.emailSummary(s.id, [MOD]);
  const mail = h.env.outbox[0];
  assert.match(mail.htmlBody, /1 questions in 1 topics · 1 dismissed/);
  assert.doesNotMatch(mail.htmlBody, /Spam spam/);
  assert.match(csvOf(mail), /"Spam spam spam"/);
});

test('summary HTML is escaped and CSV cells are formula-guarded', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: '<script>alert(1)</script>', access: 'link', active: true, moderators: [MOD] });
  h.ask(s, h.join(s), '<img src=x onerror=alert(1)> question');
  h.ask(s, h.join(s), '=HYPERLINK("http://evil","click") please');
  h.app.endSession(s.id);
  h.app.emailSummary(s.id);
  const mail = h.env.outbox[0];
  assert.doesNotMatch(mail.htmlBody, /<script>|<img/);
  assert.match(mail.htmlBody, /&lt;img src=x/);
  assert.match(csvOf(mail), /"'=HYPERLINK\(""http:\/\/evil"",""click""\) please"/);
});

test('emailLinks sends one message per recipient with the chosen links', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Links', access: 'link', moderators: [MOD] });
  const n = h.app.emailLinks(s.id, { to: 'a@example.org, b@example.org\nA@example.org', participant: true, present: true });
  assert.equal(n, 2);
  assert.deepEqual(h.env.outbox.map((m) => m.to), ['a@example.org', 'b@example.org']);
  const body = h.env.outbox[0].htmlBody;
  assert.match(body, new RegExp('k=' + s.linkKey));
  assert.match(body, /view=present/);
  assert.doesNotMatch(body, /view=moderate/);
  assert.doesNotMatch(body, /b@example\.org/, 'recipients never see each other');
});

test('Email moderators sends room screen and queue links to assigned moderators', () => {
  const h = createApp().install({ moderators: [MOD, MOD2] });
  const s = h.session({ name: 'Mods', moderators: [MOD, MOD2] });
  assert.equal(h.app.emailLinks(s.id, { toModerators: true, present: true, moderate: true }), 2);
  assert.match(h.env.outbox[0].htmlBody, /view=moderate/);

  const none = h.session({ name: 'Nobody' });
  assert.throws(() => h.app.emailLinks(none.id, { toModerators: true, present: true }), /no moderators assigned/);
});

test('emailLinks refuses bad input', () => {
  const h = createApp().install();
  const room = h.session({ name: 'Room', access: 'room' });
  assert.throws(() => h.app.emailLinks(room.id, { to: 'a@example.org', participant: true }), /In-room sessions have no shareable link/);
  assert.throws(() => h.app.emailLinks(room.id, { to: 'a@example.org' }), /Choose at least one link/);
  assert.throws(() => h.app.emailLinks(room.id, { to: '', present: true }), /at least one recipient/);
  assert.throws(() => h.app.emailLinks(room.id, { to: 'a@example.org, nope', present: true }), /Not an email address: nope/);
  const many = Array.from({ length: 51 }, (_, i) => 'p' + i + '@example.org').join(',');
  assert.throws(() => h.app.emailLinks(room.id, { to: many, present: true }), /at most 50/);
  assert.equal(h.env.outbox.length, 0);
});

test('emails stop cleanly when the daily quota is exhausted', () => {
  const h = createApp().install();
  const s = h.session({ name: 'Quota' });
  h.env.mailQuota = 1;
  assert.throws(() => h.app.emailLinks(s.id, { to: 'a@example.org, b@example.org', present: true }), /Daily email quota reached/);
  assert.equal(h.env.outbox.length, 0);
});

test('moderators cannot send email', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Admins only', moderators: [MOD] });
  h.as(MOD);
  assert.throws(() => h.app.emailLinks(s.id, { to: 'a@example.org', present: true }), /Only administrators/);
  assert.throws(() => h.app.emailSummary(s.id), /Only administrators/);
});
