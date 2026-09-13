'use strict';
/**
 * Add-in installers (docs/addin/install). The Mac installer runs for real against a
 * throwaway home folder. Windows scripts are checked here statically and run for real
 * on a Windows machine in CI (.github/workflows/test.yml, job "installers-windows").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs/addin/install');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const manifestPath = path.join(ROOT, 'docs/addin/manifest.xml');
const ADDIN_ID = fs.readFileSync(manifestPath, 'utf8').match(/<Id>([^<]+)<\/Id>/)[1];
const MANIFEST_URL = 'https://djsincla.github.io/question-desk/addin/manifest.xml';

test('every installer uses the manifest\'s add-in id and published address', () => {
  ['install-mac.sh', 'uninstall-mac.sh', 'install-windows.ps1', 'uninstall-windows.ps1'].forEach((f) => {
    const text = read(f);
    assert.ok(text.includes(ADDIN_ID), f + ' uses the manifest id');
    assert.equal((text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []).filter((id) => id !== ADDIN_ID).length, 0, f + ' has no other ids');
  });
  assert.ok(read('install-mac.sh').includes(MANIFEST_URL));
  assert.ok(read('install-windows.ps1').includes(MANIFEST_URL));
});

test('Windows installer registers the add-in where Microsoft\'s own tools do', () => {
  const ps = read('install-windows.ps1');
  assert.match(ps, /\$Key = 'HKCU:\\Software\\Microsoft\\Office\\16\.0\\Wef\\Developer'/);
  assert.match(ps, /New-ItemProperty -Path \$Key -Name \$AddinId -Value \$Manifest -PropertyType String -Force/);
  assert.doesNotMatch(ps, /HKLM:/, 'current user only');
  assert.match(read('uninstall-windows.ps1'), /Remove-ItemProperty -Path \$Key -Name \$AddinId/);
  ['Install Question Desk QR.cmd', 'Uninstall Question Desk QR.cmd'].forEach((f) => {
    const cmd = read(f);
    assert.match(cmd, /\r\n/, f + ' uses Windows line endings');
    assert.match(cmd, /powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0(un)?install-windows\.ps1"/);
  });
});

test('Mac installer installs, updates, rejects a wrong file, and uninstalls only this add-in', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-install-'));
  const wef = path.join(home, 'Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef');
  fs.mkdirSync(wef, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(wef, 'manifest.xml'));           // an old hand-copied install
  fs.writeFileSync(path.join(wef, 'other.xml'), '<OfficeApp><Id>someone-elses-addin</Id></OfficeApp>');
  const env = { ...process.env, HOME: home, QD_NO_PAUSE: '1', QD_SKIP_APP_CHECK: '1', QD_MANIFEST_URL: 'file://' + manifestPath };
  const run = (script, extraEnv) => spawnSync('bash', [path.join(DIR, script)], { env: { ...env, ...(extraEnv || {}) }, encoding: 'utf8' });
  try {
    let r = run('install-mac.sh');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(wef).sort(), [ADDIN_ID + '.manifest.xml', 'other.xml']);
    assert.equal(fs.readFileSync(path.join(wef, ADDIN_ID + '.manifest.xml'), 'utf8'), fs.readFileSync(manifestPath, 'utf8'));
    assert.match(r.stdout, /Installed Question Desk QR \d+\.\d+\.\d+\.\d+/);

    assert.equal(run('install-mac.sh').status, 0, 'running again updates in place');
    assert.deepEqual(fs.readdirSync(wef).sort(), [ADDIN_ID + '.manifest.xml', 'other.xml']);

    r = run('install-mac.sh', { QD_MANIFEST_URL: 'file://' + path.join(wef, 'other.xml') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /isn't the Question Desk QR add-in/);
    assert.ok(fs.existsSync(path.join(wef, ADDIN_ID + '.manifest.xml')), 'a bad download leaves the install alone');

    r = run('uninstall-mac.sh');
    assert.equal(r.status, 0);
    assert.deepEqual(fs.readdirSync(wef), ['other.xml']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('download zips are built from the current scripts', { skip: !fs.existsSync('/usr/bin/unzip') && process.platform !== 'linux' }, () => {
  const entry = (zip, name) => execFileSync('unzip', ['-p', path.join(DIR, zip), name], { encoding: 'utf8' });
  assert.equal(entry('QuestionDeskQR-Mac.zip', 'Install Question Desk QR.command'), read('install-mac.sh'), 'run scripts/build-addin-installers.sh');
  assert.equal(entry('QuestionDeskQR-Mac.zip', 'Uninstall Question Desk QR.command'), read('uninstall-mac.sh'));
  ['install-windows.ps1', 'uninstall-windows.ps1', 'Install Question Desk QR.cmd', 'Uninstall Question Desk QR.cmd'].forEach((f) => {
    assert.equal(entry('QuestionDeskQR-Windows.zip', f), read(f), f + ' — run scripts/build-addin-installers.sh');
  });
  const modes = execFileSync('zipinfo', [path.join(DIR, 'QuestionDeskQR-Mac.zip')], { encoding: 'utf8' });
  assert.match(modes, /-rwxr-xr-x.*Install Question Desk QR\.command/, 'Mac installer is executable after unzipping');
});
