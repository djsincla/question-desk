#!/usr/bin/env node
'use strict';
/**
 * Builds the parts of the WordPress plugin that come from the shared app, so both versions use
 * one set of pages and one text catalog:
 *
 *   pages/   the page files (Ask.html, Present.html, …, Styles.html, Scripts.html), copied as-is
 *   data/app.json   UI_TEXT (every participant-facing phrase) and the CONFIG values the server uses
 *
 * Run before starting wp-env or packaging: node wordpress/build.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../tests/harness');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(__dirname, 'question-desk');
const PAGES = ['Ask.html', 'Present.html', 'Panel.html', 'Sheet.html', 'Moderate.html', 'Coordinator.html', 'Denied.html', 'Admin.html', 'Home.html', 'Styles.html', 'Scripts.html'];

function build() {
  fs.mkdirSync(path.join(PLUGIN, 'pages'), { recursive: true });
  PAGES.forEach((file) => fs.copyFileSync(path.join(ROOT, file), path.join(PLUGIN, 'pages', file)));
  const app = createApp().app;
  // sessionCsv: the sessions CSV columns ([header, field]), so both versions read and write the same files.
  const data = { uiText: app.UI_TEXT, uiTextFor: app.UI_TEXT_FOR, config: app.CONFIG, appVersion: app.APP.version,
    sessionCsv: app.SESSION_CSV, csvTimeFormat: app.CSV_TIME_FORMAT };
  fs.mkdirSync(path.join(PLUGIN, 'data'), { recursive: true });
  fs.writeFileSync(path.join(PLUGIN, 'data', 'app.json'), JSON.stringify(data, null, 1) + '\n');
  return { pages: PAGES.length };
}

if (require.main === module) {
  const out = build();
  console.log('Built ' + out.pages + ' pages and data/app.json into wordpress/question-desk/');
}
module.exports = { build, PAGES };
