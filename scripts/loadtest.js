#!/usr/bin/env node
'use strict';
/**
 * Simulates a full room submitting at the same moment.
 *
 *   1. Admin page → Health & testing → Start load test (copies the command)
 *   2. node scripts/loadtest.js --url "https://script.google.com/macros/s/…/exec" --key <key> --count 40
 *   3. Admin page → Finish and delete test data
 *
 * Every request goes through the same server path a phone uses (session lookup,
 * lock, sheet append), minus the per-session question cap, which would
 * otherwise turn most of the burst into deliberate "busy" answers. What this
 * measures is the thing the cap can't protect: Apps Script's limit on
 * simultaneous executions and how long the script lock queues.
 *
 * No dependencies; needs Node 18+ for fetch.
 */

function args(argv) {
  const out = { count: 40, rounds: 1, pause: 5 };
  for (let i = 2; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    out[name] = argv[i + 1];
    i++;
  }
  out.count = Number(out.count);
  out.rounds = Number(out.rounds);
  out.pause = Number(out.pause);
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function submit(url, key, i) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      // text/plain avoids a CORS preflight and is what Apps Script expects in postData.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key, text: 'Load test question ' + i + ' — how will this scale?' }),
      redirect: 'follow'
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      return { ms: Date.now() - started, outcome: 'http ' + res.status + ' (not JSON)', ok: false, sample: text.slice(0, 160) };
    }
    return { ms: Date.now() - started, serverMs: body.serverMs, outcome: body.ok ? 'ok' : body.reason, ok: !!body.ok };
  } catch (err) {
    return { ms: Date.now() - started, outcome: 'network: ' + (err.cause && err.cause.code || err.message), ok: false };
  }
}

async function round(opts, n) {
  console.log('\nRound ' + n + ': ' + opts.count + ' submissions at once…');
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: opts.count }, (_, i) => submit(opts.url, opts.key, i)));
  const wall = Date.now() - started;

  const outcomes = {};
  results.forEach((r) => { outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1; });
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const server = results.filter((r) => typeof r.serverMs === 'number').map((r) => r.serverMs).sort((a, b) => a - b);

  console.log('  wall time      ' + wall + ' ms');
  console.log('  round trip     p50 ' + percentile(times, 50) + ' ms · p95 ' + percentile(times, 95) + ' ms · max ' + times[times.length - 1] + ' ms');
  if (server.length) {
    console.log('  inside script  p50 ' + percentile(server, 50) + ' ms · p95 ' + percentile(server, 95) + ' ms · max ' + server[server.length - 1] + ' ms');
  }
  Object.keys(outcomes).sort().forEach((k) => console.log('  ' + (k === 'ok' ? '✓ ' : '✗ ') + k.padEnd(28) + outcomes[k]));
  const sample = results.find((r) => r.sample);
  if (sample) console.log('  sample non-JSON response: ' + sample.sample.replace(/\s+/g, ' '));
  return results;
}

async function main() {
  const opts = args(process.argv);
  if (!opts.url || !opts.key) {
    console.error('Usage: node scripts/loadtest.js --url "https://script.google.com/macros/s/…/exec" --key <key> [--count 40] [--rounds 1] [--pause 5]');
    process.exit(2);
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(opts.url)) {
    console.error('The --url must be the app address from the Admin page (https://script.google.com/macros/s/…/exec).');
    process.exit(2);
  }

  let all = [];
  for (let n = 1; n <= opts.rounds; n++) {
    all = all.concat(await round(opts, n));
    if (n < opts.rounds) await new Promise((r) => setTimeout(r, opts.pause * 1000));
  }

  const failed = all.filter((r) => !r.ok);
  console.log('\n' + (all.length - failed.length) + ' of ' + all.length + ' submissions succeeded.');
  if (all.some((r) => r.outcome === 'disabled')) {
    console.log('"disabled" means the load test is not running or the key has expired — start it again on the Admin page.');
  }
  if (all.some((r) => r.outcome === 'busy')) {
    console.log('"busy" means requests waited more than 10 s for the script lock: the room is bigger than one deployment handles comfortably.');
  }
  if (all.some((r) => /^http|network/.test(r.outcome))) {
    console.log('HTTP or network failures usually mean Apps Script refused concurrent executions. Real phones would see "That did not send".');
  }
  console.log('Remember: Admin page → Health & testing → Finish and delete test data.');
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { args, percentile, submit, round };
