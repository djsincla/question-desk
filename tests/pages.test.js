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
const PAGES = ['Ask.html', 'Present.html', 'Panel.html', 'Moderate.html', 'Denied.html', 'Admin.html', 'Home.html'];
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

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const scripts = inlineScripts(html);

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
    scriptlets.forEach((s) => assert.ok(s === '<?!= boot ?>' || s === '<?!= styles ?>', page + ' has an unexpected scriptlet ' + s));
    if (scriptlets.indexOf('<?!= boot ?>') !== -1) assert.match(html, /var BOOT = <\?!= boot \?>;/);
    // The shared stylesheet goes in the head, before the page's own styles so they can override it.
    if (scriptlets.indexOf('<?!= styles ?>') !== -1) {
      assert.ok(html.indexOf('<?!= styles ?>') < html.indexOf('<style>'), page + ': shared styles come before the page styles');
      assert.ok(html.indexOf('<?!= styles ?>') < html.indexOf('</head>'), page + ': shared styles are in the head');
    }
  });
}

test('the shared stylesheet is one style block, uploaded with the app, and used by every page but the room screen', () => {
  const css = fs.readFileSync(path.join(ROOT, 'Styles.html'), 'utf8').trim();
  assert.match(css, /^<style>[\s\S]*<\/style>$/);
  assert.equal((css.match(/<style>/g) || []).length, 1);
  assert.doesNotMatch(css, /<\?|<script|@import|url\(/, 'no scriptlets, scripts or external resources');
  assert.match(fs.readFileSync(path.join(ROOT, '.claspignore'), 'utf8'), /^!Styles\.html$/m);
  PAGES.filter((p) => p !== 'Present.html').forEach((p) => {
    assert.match(fs.readFileSync(path.join(ROOT, p), 'utf8'), /<\?!= styles \?>/, p + ' includes the shared styles');
  });
  assert.match(SERVER, /template\.styles = HtmlService\.createHtmlOutputFromFile\('Styles'\)\.getContent\(\);/);
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
