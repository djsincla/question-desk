'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const MOD = 'mod@example.org';

test('the bare app address shows the branded landing page to everyone', () => {
  const h = createApp().install();
  h.app.saveBrand({ orgName: 'Example Society', welcome: 'Thanks for coming', footer: 'example.org' });
  h.anonymous();
  const page = h.app.doGet({ parameter: {} });
  assert.equal(page.file, 'Home.html');
  assert.equal(page.title, 'Example Society — Question Desk');
  assert.equal(page.data.staff, false);
  assert.deepEqual(page.data.sessions, []);
  assert.equal(page.data.adminUrl, '');
  assert.equal(page.data.brand.welcome, 'Thanks for coming');
  assert.match(page.data.signInUrl, /^https:\/\/accounts\.google\.com\/AccountChooser\?continue=https%3A%2F%2Fscript\.google\.com%2Fmacros%2Fs%2FDEPLOYID%2Fexec$/);
});

test('a bad or missing session link still goes to the participant page, not the landing page', () => {
  const h = createApp().install();
  h.anonymous();
  assert.equal(h.app.doGet({ parameter: { s: 'ffffffff', t: 'x' } }).file, 'Ask.html');
  assert.equal(h.app.doGet({ parameter: { s: '' , k: 'x' } }).file, 'Home.html');
});

test('moderators see only their open sessions; admins also get the admin link', () => {
  const h = createApp().install({ moderators: [MOD] });
  const mine = h.session({ name: 'Mine', moderators: [MOD], active: true });
  h.session({ name: 'Not mine', active: true });
  const done = h.session({ name: 'Done', moderators: [MOD], active: true });
  h.app.endSession(done.id);
  h.app.startLoadTest();

  h.as(MOD);
  let page = h.app.doGet({ parameter: {} });
  assert.equal(page.data.staff, true);
  assert.equal(page.data.adminUrl, '');
  assert.deepEqual(page.data.sessions.map((s) => s.name), ['Mine']);
  assert.match(page.data.sessions[0].present, new RegExp('view=present&s=' + mine.id));

  h.as(h.env.owner);
  page = h.app.doGet({ parameter: {} });
  assert.match(page.data.adminUrl, /\?view=admin$/);
  assert.deepEqual(page.data.sessions.map((s) => s.name).sort(), ['Mine', 'Not mine'], 'no ended or load-test sessions');
});

test('landing page title falls back when no organization name is set', () => {
  const h = createApp().install();
  assert.equal(h.app.doGet({ parameter: {} }).title, 'Question Desk');
});
