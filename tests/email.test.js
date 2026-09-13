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

  const res = h.app.endSession(s.id, h.app.getSession_(s.id).name);
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
  h.app.endSession(s.id, h.app.getSession_(s.id).name);
  assert.equal(h.env.geminiCalls.length, 1);
  assert.doesNotMatch(h.env.outbox[0].htmlBody, /Not grouped/);
});

test('the summary still sends when final grouping fails', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Gemini down', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  h.ask(s, h.join(s), 'Will this still arrive?');
  h.env.gemini = () => ({ status: 503, text: 'unavailable' });
  const res = h.app.endSession(s.id, h.app.getSession_(s.id).name);
  assert.equal(res.emailed, 1);
  assert.match(res.note, /Final grouping failed/);
  assert.match(h.env.outbox[0].htmlBody, /Not grouped/);
});

test('no email when the session does not ask for one', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Quiet', active: true, moderators: [MOD], emailOnEnd: false });
  assert.equal(h.app.endSession(s.id, h.app.getSession_(s.id).name).emailed, 0);
  assert.equal(h.env.outbox.length, 0);
});

test('dismissed questions are counted but left out of the summary body, kept in the CSV', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Dismissed', access: 'link', active: true, moderators: [MOD] });
  h.ask(s, h.join(s), 'Keep this question');
  h.ask(s, h.join(s), 'Spam spam spam');
  h.app.setStatus(s.id, [h.questions().rows[2][0]], 'dismissed');
  h.app.endSession(s.id, h.app.getSession_(s.id).name);
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
  h.app.endSession(s.id, h.app.getSession_(s.id).name);
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
  assert.throws(() => h.app.emailLinks(none.id, { toModerators: true, present: true }), /no QA Facilitators assigned/);
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

// ------------------------------------------------------------ custom recipients

test('by default the summary goes to the session\'s QA Facilitators', () => {
  const h = createApp().install({ moderators: [MOD, MOD2] });
  const s = h.session({ name: 'Default', access: 'link', active: true, moderators: [MOD, MOD2], emailOnEnd: true });
  assert.deepEqual(h.app.adminState().sessions[0].summaryTo, [MOD, MOD2]);
  h.app.endSession(s.id, 'Default');
  assert.equal(h.env.outbox[0].to, MOD + ',' + MOD2);
});

test('the organization default can add outside addresses or drop facilitators', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.saveSummaryDefaults({ facilitators: true, extra: 'board@partner.test, Chair@partner.test\nboard@partner.test' });
  const s = h.session({ name: 'Board copy', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  assert.deepEqual(h.app.adminState().summaryDefaults, { facilitators: true, extra: ['board@partner.test', 'chair@partner.test'] });
  h.app.endSession(s.id, 'Board copy');
  assert.equal(h.env.outbox[0].to, [MOD, 'board@partner.test', 'chair@partner.test'].join(','));

  h.app.saveSummaryDefaults({ facilitators: false, extra: 'records@example.org' });
  const t = h.session({ name: 'Records only', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  h.app.endSession(t.id, 'Records only');
  assert.equal(h.env.outbox[1].to, 'records@example.org');

  assert.throws(() => h.app.saveSummaryDefaults({ facilitators: false, extra: '' }), /at least one address/);
  assert.throws(() => h.app.saveSummaryDefaults({ extra: 'not an email' }), /Not an email address/);
});

test('a session can override the default recipients, and edits without recipients keep them', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.saveSummaryDefaults({ facilitators: true, extra: 'board@partner.test' });
  h.app.saveSession({ name: 'Partner event', access: 'link', moderators: [MOD], emailOnEnd: true,
    summary: { mode: 'custom', facilitators: false, extra: 'partner-lead@partner.test' } });
  const s = h.app.allSessions_()[0];
  assert.deepEqual(h.app.adminState().sessions[0].summaryTo, ['partner-lead@partner.test']);

  h.app.saveSession({ id: s.id, name: 'Partner event renamed', access: 'link', moderators: [MOD], emailOnEnd: true });
  assert.deepEqual(h.app.adminState().sessions[0].summaryTo, ['partner-lead@partner.test'], 'kept');

  h.app.setSessionActive(s.id, true);
  h.app.endSession(s.id, 'Partner event renamed');
  assert.equal(h.env.outbox[0].to, 'partner-lead@partner.test');

  h.app.saveSession({ id: s.id, name: 'Partner event renamed', access: 'link', moderators: [MOD], summary: { mode: 'default' } });
  assert.deepEqual(h.app.adminState().sessions[0].summaryTo, [MOD, 'board@partner.test'], 'back to default');
});

test('Email summary resends to the resolved recipients unless others are typed', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.saveSession({ name: 'Resend', access: 'link', moderators: [MOD], summary: { mode: 'custom', facilitators: true, extra: 'x@partner.test' } });
  const s = h.app.allSessions_()[0];
  h.app.setSessionActive(s.id, true);
  h.app.endSession(s.id, 'Resend');
  h.app.emailSummary(s.id);
  assert.equal(h.env.outbox[0].to, MOD + ',x@partner.test');
  h.app.emailSummary(s.id, ['someone@partner.test']);
  assert.equal(h.env.outbox[1].to, 'someone@partner.test');
});

test('only admins change summary recipients', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.as(MOD);
  assert.throws(() => h.app.saveSummaryDefaults({ facilitators: true }), /Only administrators/);
});

test('the summary keeps original wording and the English translation for every question', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'Languages', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  h.ask(s, h.join(s), 'Parking is a problem');
  h.ask(s, h.join(s), '주차 공간이 부족합니다');
  h.env.gemini = (call) => {
    const lines = call.prompt.split('New questions:\n')[1].split('\n\nDo not invent')[0].split('\n').filter(Boolean);
    return {
      assignments: lines.map((line) => {
        const id = line.slice(0, 8);
        const korean = /주차/.test(line);
        return { id, topic: 'Parking', language: korean ? 'Korean' : 'English',
                 translation: korean ? 'There is not enough parking' : line.slice(10) };
      }),
      labels: [{ topic: 'Parking', translations: { ko: '주차', es: 'Estacionamiento' } }]
    };
  };
  h.app.clusterQuestions();
  h.as(MOD).app.setTopicShown(s.id, 'Parking', true);
  h.as(h.env.owner).app.endSession(s.id, 'Languages');

  const mail = h.env.outbox[0];
  assert.match(mail.htmlBody, /There is not enough parking<br><span[^>]*>Original \(Korean\): 주차 공간이 부족합니다/);
  assert.match(mail.htmlBody, /<li[^>]*>Parking is a problem<\/li>/, 'English question shown once');
  assert.match(mail.htmlBody, /shown on phones/);

  const csv = mail.attachments[0].getDataAsString().split('\r\n');
  assert.match(csv[0], /"Original language","Original question","English translation",.*"Topic shown on phones"/);
  const korean = csv.find((line) => /주차 공간/.test(line));
  assert.match(korean, /"Korean","주차 공간이 부족합니다","There is not enough parking"/);
  assert.match(korean, /"yes"$/);
  const english = csv.find((line) => /Parking is a problem/.test(line));
  assert.match(english, /"English","Parking is a problem","Parking is a problem"/);
});

test('questions that were never translated are labeled, never silently dropped', () => {
  const h = createApp().install({ moderators: [MOD] });
  const s = h.session({ name: 'No Gemini', access: 'link', active: true, moderators: [MOD], emailOnEnd: true });
  h.ask(s, h.join(s), '¿Hay transporte para las familias?');
  h.env.gemini = () => ({ status: 503, text: 'down' });
  h.app.endSession(s.id, 'No Gemini');
  const mail = h.env.outbox[0];
  assert.match(mail.htmlBody, /¿Hay transporte para las familias\?<br><span[^>]*>Original wording — not translated/);
  assert.match(mail.attachments[0].getDataAsString(), /"¿Hay transporte para las familias\?","\(not translated\)"/);
});

test('original wording is never overwritten by grouping, approval, answering or use', () => {
  const h = createApp().install({ moderators: [MOD] });
  h.app.saveSession({ name: 'Keep', access: 'link', moderators: [MOD], prepared: 'Prepared original wording here?' });
  const s = h.app.allSessions_()[0];
  h.app.setSessionActive(s.id, true);
  h.ask(h.app.getSession_(s.id), h.join(h.app.getSession_(s.id)), 'Asked original wording here');
  h.as(MOD);
  h.app.usePrepared(s.id, [h.app.getBoard(s.id).prepared[0].id]);
  h.app.clusterQuestions();
  const board = h.app.getBoard(s.id);
  board.topics.forEach((t) => h.app.setTopicShown(s.id, t.topic, true));
  h.app.setStatus(s.id, board.topics[0].questions.map((q) => q.id), 'answered');
  const texts = h.questions().rows.slice(1).map((r) => r[3]).sort();
  assert.deepEqual(texts, ['Asked original wording here', 'Prepared original wording here?']);
});
