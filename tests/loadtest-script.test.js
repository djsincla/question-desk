'use strict';
/** Runs scripts/loadtest.js against a local HTTP server backed by the real doPost. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('./harness');
const loadtest = require('../scripts/loadtest');

function serve(h) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const out = h.post(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('loadtest.js submits a burst and reports outcomes', async () => {
  const h = createApp().install();
  const key = h.app.startLoadTest().loadTest.key;
  const server = await serve(h);
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    const results = await loadtest.round({ url, key, count: 25 }, 1);
    assert.equal(results.length, 25);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    assert.ok(lines.some((l) => /✓ ok\s+25/.test(l)));

    const bad = await loadtest.round({ url, key: 'wrong', count: 3 }, 2);
    assert.ok(bad.every((r) => r.outcome === 'disabled'));
  } finally {
    console.log = log;
    server.close();
  }
  assert.equal(h.questions().rows.length, 26);
});

test('loadtest.js argument parsing and percentiles', () => {
  const opts = loadtest.args(['node', 'x', '--url', 'u', '--key', 'k', '--count', '60']);
  assert.deepEqual([opts.url, opts.key, opts.count, opts.rounds], ['u', 'k', 60, 1]);
  assert.equal(loadtest.percentile([10, 20, 30, 40], 50), 30);
  assert.equal(loadtest.percentile([], 95), 0);
});

test('loadtest.js tells a reply lost on Google\'s redirect from a question that wasn\'t saved', async () => {
  const h = createApp().install();
  const key = h.app.startLoadTest().loadTest.key;
  let n = 0;
  // Every third reply is replaced by one of Google's HTML pages, after the question was saved.
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const out = h.post(body);
        const isCount = JSON.parse(body).action === 'count';
        if (!isCount && ++n % 3 === 0) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!doctype html><html><head><script>window.ppConfig = {}</script></head></html>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const opts = { url: 'http://127.0.0.1:' + server.address().port + '/', key, count: 9 };
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    const before = await loadtest.savedCount(opts);
    const results = await loadtest.round(opts, 1);
    const after = await loadtest.savedCount(opts);
    assert.equal(results.filter((r) => r.replyLost).length, 3);
    assert.equal(after - before, 9, 'all nine were saved');
    assert.ok(lines.some((l) => /reply lost \(Google page\)\s+3/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /lock wait\s+p50 \d+/.test(l)), 'shows where the time went');
  } finally {
    console.log = log;
    server.close();
  }
});
