#!/usr/bin/env node
'use strict';
/**
 * Builds the installable plugin zip: wordpress/dist/question-desk-<version>.zip
 *
 * The zip holds one folder, question-desk/, with the plugin and the built pages and data —
 * and nothing that only matters while developing (tests, composer, vendor). Install it in
 * WordPress with Plugins → Add New → Upload Plugin.
 *
 *   npm run wp:package
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('./build');

const PLUGIN = path.join(__dirname, 'question-desk');
const DIST = path.join(__dirname, 'dist');

// Everything in the plugin folder except these: they belong to developing it, not to running it.
const SKIP = ['tests', 'vendor', 'node_modules', 'composer.json', 'composer.lock', 'phpunit.xml.dist', '.phpunit.cache', '.DS_Store'];

function version() {
  const header = fs.readFileSync(path.join(PLUGIN, 'question-desk.php'), 'utf8');
  const found = header.match(/^\s*\*\s*Version:\s*([0-9][0-9.]*)\s*$/m);
  if (!found) throw new Error('No Version in the plugin header.');
  return found[1];
}

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.includes(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copy(source, target);
    else fs.copyFileSync(source, target);
  }
}

function pack() {
  build();
  const name = 'question-desk-' + version() + '.zip';
  const staging = path.join(DIST, 'staging');
  fs.rmSync(staging, { recursive: true, force: true });
  copy(PLUGIN, path.join(staging, 'question-desk'));
  fs.mkdirSync(DIST, { recursive: true });
  const zip = path.join(DIST, name);
  fs.rmSync(zip, { force: true });
  // -X leaves out the extra attributes, so the same files make the same zip.
  execFileSync('zip', ['-qrX', zip, 'question-desk'], { cwd: staging });
  fs.rmSync(staging, { recursive: true, force: true });
  return { zip, name, version: version(), bytes: fs.statSync(zip).size };
}

if (require.main === module) {
  const out = pack();
  console.log('Built ' + out.name + ' (' + Math.round(out.bytes / 1024) + ' KB) in wordpress/dist/');
}
module.exports = { pack, version, SKIP };
