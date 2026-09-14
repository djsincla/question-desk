'use strict';
/**
 * The server code as Apps Script sees it: Code.js (settings, constants, routing) plus every
 * file in server/, run as one program. The harness and the static checks both read it here.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER_FILES = ['Code.js'].concat(
  fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js')).sort().map((f) => 'server/' + f)
);
const SERVER_SOURCE = SERVER_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

module.exports = { ROOT, SERVER_FILES, SERVER_SOURCE };
