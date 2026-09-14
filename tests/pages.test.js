'use strict';
/**
 * Static checks on the HTML pages. These pages can't run under Node, but the
 * mistakes that break them in production can be caught here: a script that
 * doesn't parse, syntax older phones reject, a call to a server function that
 * doesn't exist or is private (trailing underscore — google.script.run refuses
 * those), and a raw U+2028 that silently ends a JS line.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGES = ['Ask.html', 'Present.html', 'Panel.html', 'Sheet.html', 'Moderate.html', 'Denied.html', 'Admin.html', 'Home.html'];
const SERVER = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const SERVER_FUNCTIONS = new Set(Array.from(SERVER.matchAll(/^function ([A-Za-z0-9_]+)\s*\(/gm), (m) => m[1]));

function inlineScripts(html) {
  return Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (m) => m[1]);
}

/** Server functions a page calls through google.script.run (directly or via Admin's call helper). */
function serverCalls(js) {
  const names = new Set();
  const patterns = [
    /google\.script\.run\s*\.\s*([A-Za-z0-9_]+)\s*\(/g,
    /\}\s*\)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g,
    /withSuccessHandler\(\s*[A-Za-z0-9_]+\s*\)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g,
    /\bcall\(\s*'([A-Za-z0-9_]+)'/g,
    /\bsend\(\s*'([A-Za-z0-9_]+)'/g          // Moderate's optimistic save helper
  ];
  patterns.forEach((re) => {
    for (const m of js.matchAll(re)) {
      if (!/^with(Success|Failure)Handler$|^withUserObject$/.test(m[1])) names.add(m[1]);
    }
  });
  return names;
}

const HARNESS = require('./harness').createApp().install();

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  // The page's own scripts, and the shared script it gets from Scripts.html: same checks for both.
  const shared = inlineScripts(HARNESS.app.scriptsFor_(page));
  const scripts = inlineScripts(html).concat(shared);

  test(page + ': its own script never redeclares a name from the shared script', () => {
    const top = (js) => Array.from(js.matchAll(/^ {0,2}(?:var|function)\s+([A-Za-z_$][\w$]*)/gm), (m) => m[1]);
    const sharedNames = new Set(shared.flatMap(top));
    inlineScripts(html).flatMap(top).forEach((name) => {
      assert.ok(!sharedNames.has(name), page + ' declares ' + name + ', which Scripts.html already defines for it');
    });
    if (html.indexOf('<?!= scripts ?>') !== -1) {
      assert.ok(html.indexOf('<?!= scripts ?>') < html.indexOf('<script>'), page + ': the shared script comes before the page script');
    }
  });

  test(page + ': inline scripts parse', () => {
    assert.ok(scripts.length > 0);
    scripts.forEach((js) => {
      const withBoot = js.replace('<?!= boot ?>', '{"brand":{}}');
      assert.doesNotThrow(() => new Function(withBoot), page);
    });
  });

  test(page + ': ES5-only syntax for older phones', () => {
    scripts.forEach((js) => {
      const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
      assert.doesNotMatch(code, /=>/, page + ' uses an arrow function');
      assert.doesNotMatch(code, /\b(let|const|class)\s/, page + ' uses let/const/class');
      assert.doesNotMatch(code, /`/, page + ' uses a template literal');
      assert.doesNotMatch(code, /\basync\b|\bawait\b/, page + ' uses async/await');
    });
  });

  test(page + ': no top-level variable shadows a built-in window property', () => {
    // A top-level `var status` is window.status, which turns anything stored into a string:
    // the room screen's status line silently never showed because of exactly that.
    const RESERVED = /^(status|name|top|parent|self|length|origin|closed|opener|frames|history|location|event|screen|external|performance|crypto|close|open|print|stop|focus|blur|find|alert|menubar|toolbar|scrollbars|personalbar|locationbar|statusbar|frameElement|navigator|document|window|onload|onerror)$/;
    scripts.forEach((js) => {
      // Top level of the page script: two-space indented declarations (functions are indented further).
      for (const m of js.matchAll(/^ {0,2}(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)) {
        assert.doesNotMatch(m[1], RESERVED, page + ' declares top-level ' + m[1] + ', which is a window property');
      }
    });
  });

  test(page + ': only calls public server functions that exist', () => {
    const calls = new Set();
    scripts.forEach((js) => serverCalls(js).forEach((n) => calls.add(n)));
    calls.forEach((name) => {
      if (!SERVER_FUNCTIONS.has(name)) {
        // Chained DOM/array methods also match the pattern; only flag names that look like ours.
        if (/^(forEach|map|filter|join|push|appendChild|getElementById|querySelector|addEventListener|replace|split|slice|indexOf|setAttribute|focus|select|toLowerCase|trim|apply|call|test|concat|sort|substr|toString|getAttribute|then)$/.test(name)) return;
        assert.fail(page + ' calls unknown server function ' + name + '()');
      }
      assert.doesNotMatch(name, /_$/, page + ' calls private server function ' + name + '()');
    });
  });

  test(page + ': uses template boot data only through BOOT', () => {
    const scriptlets = html.match(/<\?[\s\S]*?\?>/g) || [];
    scriptlets.forEach((s) => assert.ok(['<?!= boot ?>', '<?!= styles ?>', '<?!= scripts ?>'].indexOf(s) !== -1, page + ' has an unexpected scriptlet ' + s));
    if (scriptlets.indexOf('<?!= boot ?>') !== -1) assert.match(html, /var BOOT = <\?!= boot \?>;/);
    // Styles come only from Styles.html, in the head.
    assert.ok(html.indexOf('<?!= styles ?>') !== -1 && html.indexOf('<?!= styles ?>') < html.indexOf('</head>'), page + ': styles are in the head');
  });

  test(page + ': has no styles of its own (they all live in Styles.html)', () => {
    assert.doesNotMatch(html, /<style[\s>]/, page + ' has a style block: move it to its section of Styles.html');
    assert.doesNotMatch(html, /\sstyle=["']/, page + ' has a style attribute: use a class from Styles.html');
    assert.doesNotMatch(html, /cssText|setAttribute\(\s*['"]style['"]/, page + ' sets styles from a script');
    // Scripts may only set values that come from data: brand colors, a meter's width.
    const sets = Array.from(html.matchAll(/\.style\.([A-Za-z]+)/g), (m) => m[1]).filter((prop) => prop !== 'setProperty');
    sets.forEach((prop) => assert.ok(['width', 'background'].indexOf(prop) !== -1, page + ' sets style.' + prop + ' from a script: use a class'));
    Array.from(html.matchAll(/\.style\.setProperty\(\s*'([^']+)'/g), (m) => m[1]).forEach((name) => {
      assert.match(name, /^--/, page + ' sets ' + name + ' from a script: only CSS variables (brand colors)');
    });
  });
}

test('every style is in Styles.html: one style block, a section per page, and each page gets only its own', () => {
  const css = fs.readFileSync(path.join(ROOT, 'Styles.html'), 'utf8').trim();
  assert.match(css, /^<style>[\s\S]*<\/style>$/);
  assert.equal((css.match(/<style>/g) || []).length, 1);
  assert.doesNotMatch(css, /<\?|<script|@import|url\(/, 'no scriptlets, scripts or external resources');
  assert.match(fs.readFileSync(path.join(ROOT, '.claspignore'), 'utf8'), /^!Styles\.html$/m);
  assert.match(SERVER, /template\.styles = stylesFor_\(file\);/);

  const sections = Array.from(css.matchAll(/\/\* =+ @pages ([A-Za-z ]+) \*\//g), (m) => m[1].split(' '));
  const names = PAGES.map((p) => p.replace('.html', ''));
  names.forEach((name) => {
    assert.ok(sections.some((list) => list.length === 1 && list[0] === name), 'Styles.html has a section for ' + name);
  });
  sections.flat().forEach((name) => assert.ok(names.indexOf(name) !== -1, 'section for an unknown page: ' + name));

  const { createApp } = require('./harness');
  const h = createApp().install();
  const forPage = (p) => h.app.stylesFor_(p);
  names.forEach((name) => {
    const out = forPage(name + '.html');
    assert.match(out, /^<style>\n[\s\S]+<\/style>$/);
    assert.doesNotMatch(out, /@pages/, 'markers are stripped');
  });
  // Each page gets the shared section (except the room screen) and its own, never another page's.
  assert.match(forPage('Ask.html'), /--action:/);
  assert.match(forPage('Ask.html'), /\.metoo/);
  assert.doesNotMatch(forPage('Ask.html'), /#gemForm/, 'phones never download the Admin styles');
  assert.match(forPage('Admin.html'), /#gemForm/);
  assert.doesNotMatch(forPage('Admin.html'), /qr-only/);
  assert.match(forPage('Present.html'), /qr-only/);
  assert.doesNotMatch(forPage('Present.html'), /label\.field/, 'the room screen keeps only its projector styles');
});

test('no raw U+2028/U+2029 in any source file', () => {
  const files = ['Code.js'].concat(PAGES, fs.readdirSync(__dirname).map((f) => path.join('tests', f)));
  files.forEach((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']'), f);
  });
});

test('every page the server renders exists, and every page is pushed by clasp', () => {
  const rendered = new Set(Array.from(SERVER.matchAll(/page_\('([A-Za-z]+\.html)'/g), (m) => m[1]));
  rendered.forEach((file) => assert.ok(fs.existsSync(path.join(ROOT, file)), file + ' is rendered but missing'));
  const claspignore = fs.readFileSync(path.join(ROOT, '.claspignore'), 'utf8');
  PAGES.concat(['Code.js', 'appsscript.json']).forEach((file) => {
    assert.match(claspignore, new RegExp('^!' + file.replace('.', '\\.') + '$', 'm'), file + ' missing from .claspignore allowlist');
  });
});

test('manifest keeps anonymous web app access and the scopes the code needs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  const needs = {
    'SpreadsheetApp.': 'https://www.googleapis.com/auth/spreadsheets',
    'UrlFetchApp.': 'https://www.googleapis.com/auth/script.external_request',
    'ScriptApp.newTrigger': 'https://www.googleapis.com/auth/script.scriptapp',
    'MailApp.': 'https://www.googleapis.com/auth/script.send_mail',
    'getActiveUser()': 'https://www.googleapis.com/auth/userinfo.email'
  };
  Object.keys(needs).forEach((usage) => {
    if (SERVER.indexOf(usage) !== -1) assert.ok(manifest.oauthScopes.includes(needs[usage]), usage + ' needs ' + needs[usage]);
  });
});

test('shared script: one script block in Scripts.html, sections for real pages, each page gets only its own', () => {
  const js = fs.readFileSync(path.join(ROOT, 'Scripts.html'), 'utf8').trim();
  assert.match(js, /^<script>[\s\S]*<\/script>$/);
  assert.equal((js.match(/<script>/g) || []).length, 1);
  assert.doesNotMatch(js, /<\?|google\.script\.run|src=/, 'no scriptlets, server calls or external scripts');
  assert.match(fs.readFileSync(path.join(ROOT, '.claspignore'), 'utf8'), /^!Scripts\.html$/m);
  assert.match(SERVER, /template\.scripts = scriptsFor_\(file\);/);
  const names = PAGES.map((p) => p.replace('.html', ''));
  Array.from(js.matchAll(/\/\* =+ @pages ([A-Za-z ]+) \*\//g), (m) => m[1].split(' ')).flat()
    .forEach((name) => assert.ok(names.indexOf(name) !== -1, 'section for an unknown page: ' + name));
  // Each page that uses a helper gets it, and only the pages that use it.
  const forPage = (p) => HARNESS.app.scriptsFor_(p);
  assert.match(forPage('Present.html'), /function qrArt\(/);
  assert.match(forPage('Sheet.html'), /function qrArt\(/);
  assert.doesNotMatch(forPage('Admin.html'), /function qrArt\(/);
  assert.match(forPage('Moderate.html'), /function ask\(/);
  assert.match(forPage('Panel.html'), /function tellFrame\(/);
  assert.equal(forPage('Ask.html'), '', 'the participant page needs none, so gets nothing');
  // Rounded corners only: every dark module is drawn, so the code scans like the square one.
  assert.match(forPage('Present.html'), /if \(dark\(r, c\)\)/);
  // Any page that uses the shared script includes it.
  PAGES.forEach((p) => {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    assert.equal(html.indexOf('<?!= scripts ?>') !== -1, forPage(p) !== '', p + ' includes the shared script exactly when it has sections');
  });
});
