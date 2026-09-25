#!/usr/bin/env node
'use strict';
/**
 * Blocks secrets and identifying details from entering git.
 *
 *   node scripts/check-secrets.js            scan every tracked file
 *   node scripts/check-secrets.js --staged   scan what is about to be committed (pre-commit hook)
 *   node scripts/check-secrets.js --history  scan every commit, message and diff
 *
 * Real email addresses are refused outright; tests and docs use example.org.
 * Script and deployment IDs belong in untracked local files (.clasp.json,
 * .deploy.env), never in the repository.
 */
const { execFileSync } = require('node:child_process');

const PATTERNS = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/g],
  ['Google OAuth token', /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ['OAuth refresh token', /"refresh_token"\s*:\s*"[^"]{10,}"/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['API secret key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/g],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Apps Script deployment ID', /\bAKfycb[A-Za-z0-9_-]{30,}/g],
  ['Apps Script project ID', /"scriptId"\s*:\s*"(?!YOUR_SCRIPT_ID)[^"]+"/g],
  ['Apps Script project ID', /script\.google\.com\/(?:d|home\/projects)\/[A-Za-z0-9_-]{20,}/g],
  ['OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ['Email address', /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g]
];

// Placeholder and machine domains that are fine to publish.
const ALLOWED_EMAIL = /^(?:[A-Za-z0-9._%+-]+@(?:example\.(?:org|com|net)|[a-z0-9-]+\.test|users\.noreply\.github\.com)|name@domain\.org|nombre@dominio\.org|noreply@anthropic\.com)$/i;

const FORBIDDEN_FILES = [/(^|\/)\.clasp\.json$/, /(^|\/)\.clasprc\.json$/, /(^|\/)\.deploy\.env$/, /(^|\/)\.env(\..*)?$/, /\.pem$/, /\.p12$/];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function scanText(text, where) {
  const findings = [];
  PATTERNS.forEach(([name, re]) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (name === 'Email address' && ALLOWED_EMAIL.test(m[0])) continue;
      // npm's lock file lists third-party package authors' published addresses; not ours to hide.
      // Every other pattern (keys, tokens, IDs) still applies to it.
      if (name === 'Email address' && /(^|\/)package-lock\.json$/.test(where)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ where, line, name, match: m[0].length > 12 ? m[0].slice(0, 6) + '…' + m[0].slice(-4) : m[0] });
    }
  });
  return findings;
}

function scanFiles(files, read) {
  let findings = [];
  files.forEach((file) => {
    if (FORBIDDEN_FILES.some((re) => re.test(file))) {
      findings.push({ where: file, line: 0, name: 'File must stay local (see .gitignore)', match: file });
      return;
    }
    if (/^LICENSE$/.test(file)) return;
    let text;
    try {
      text = read(file);
    } catch (err) {
      // Never skip silently: an unreadable file is exactly where a secret could hide.
      findings.push({ where: file, line: 0, name: 'Could not read file to scan it', match: String(err.message).split('\n')[0].slice(0, 60) });
      return;
    }
    if (text.indexOf(String.fromCharCode(0)) !== -1) return; // binary
    findings = findings.concat(scanText(text, file));
  });
  return findings;
}

function main() {
  const mode = process.argv[2] || '--tracked';
  let findings;
  if (mode === '--staged') {
    // -z: paths with spaces or accents come back unquoted.
    const files = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).split('\0').filter(Boolean);
    findings = scanFiles(files, (f) => git(['show', ':' + f]));
  } else if (mode === '--history') {
    const log = git(['log', '--all', '-p', '--format=commit %H%nAuthor: %an <%ae>%n%n%B']);
    findings = scanText(log.split(/\n(?=commit [0-9a-f]{40}\n)/).map((chunk) => chunk
      // The license text's own URLs and placeholders are not findings.
      .replace(/^[+-] .*apache\.org.*$/gm, '')).join('\n'), 'git history');
  } else {
    const files = git(['ls-files', '-z']).split('\0').filter(Boolean).filter((f) => require('node:fs').existsSync(f));
    findings = scanFiles(files, (f) => require('node:fs').readFileSync(f, 'utf8'));
  }

  if (findings.length) {
    console.error('Refusing: possible secrets or identifying details found.\n');
    findings.forEach((f) => console.error('  ' + f.where + (f.line ? ':' + f.line : '') + '  ' + f.name + '  ' + f.match));
    console.error('\nMove real values to untracked config (.clasp.json, .deploy.env, Script Properties) and use example.org in tests and docs.');
    process.exit(1);
  }
  console.log('Secret scan clean (' + mode.replace('--', '') + ').');
}

if (require.main === module) main();
module.exports = { scanText, scanFiles, ALLOWED_EMAIL };
