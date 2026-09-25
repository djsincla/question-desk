#!/usr/bin/env node
'use strict';
/**
 * Local preview of every page, with demo data, no Google account needed.
 *
 *   node scripts/preview.js            → http://localhost:8787
 *
 * Runs the real server code (Code.js and server/) on the test harness's fake Apps Script services and
 * stands in for google.script.run with a small fetch shim, so pages behave as
 * they do when deployed. Choose who you are with ?as=owner | mod | anon.
 * Used by scripts/screenshots.js; handy for checking page changes before a ship.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../tests/harness');

const ROOT = path.join(__dirname, '..');
const USERS = { owner: 'owner@example.org', mod: 'maria@example.org', anon: '' };

// ------------------------------------------------------------ demo data

const QUESTIONS = [
  // text, language, English translation, topic
  ['Are respite care hours going to be cut next year? We already wait months.', 'English', null, 'Respite care hours'],
  ['내년에 휴식 돌봄 시간이 줄어드나요? 지금도 몇 달을 기다립니다.', 'Korean', 'Will respite care hours be reduced next year? We already wait months.', 'Respite care hours'],
  ['¿Por qué las horas de respiro se asignan sin consultar a las familias?', 'Spanish', 'Why are respite hours assigned without consulting families?', 'Respite care hours'],
  ['How do we request more respite hours when a parent is sick?', 'English', null, 'Respite care hours'],
  ['My son\'s IEP meeting keeps getting postponed. Who can help us push back?', 'English', null, 'IEP and school support'],
  ['학교에서 IEP 통역을 제공하지 않습니다. 어떻게 요청하나요?', 'Korean', 'The school does not provide interpretation for IEP meetings. How do we request it?', 'IEP and school support'],
  ['¿Pueden acompañarnos a una reunión del IEP?', 'Spanish', 'Can someone come with us to an IEP meeting?', 'IEP and school support'],
  ['What is the real wait time for a diagnostic evaluation right now?', 'English', null, 'Evaluation waitlists'],
  ['La lista de espera para la evaluación es de más de un año. ¿Qué podemos hacer mientras tanto?', 'Spanish', 'The waitlist for evaluation is over a year. What can we do in the meantime?', 'Evaluation waitlists'],
  ['Is there a quiet room during events for kids who get overwhelmed?', 'English', null, 'Sensory-friendly events'],
  ['Will the next meeting have Korean interpretation for the whole program?', 'English', null, null]
];

const LABELS = {
  'Respite care hours': { ko: '휴식 돌봄 시간', es: 'Horas de cuidado de respiro', zh: '喘息照护时数' },
  'IEP and school support': { ko: 'IEP 및 학교 지원', es: 'IEP y apoyo escolar', zh: 'IEP 与学校支持' },
  'Evaluation waitlists': { ko: '평가 대기자 명단', es: 'Listas de espera para evaluación', zh: '评估候补名单' },
  'Sensory-friendly events': { ko: '감각 친화적 행사', es: 'Eventos sensorialmente amigables', zh: '感官友好活动' }
};

const MERGED = {
  question: 'Will respite care hours be cut next year, and how will families be consulted before hours are assigned or changed?',
  translations: {
    ko: '내년에 휴식 돌봄 시간이 줄어드나요? 시간을 배정하거나 변경하기 전에 가족의 의견을 어떻게 들을 건가요?',
    es: '¿Se reducirán las horas de respiro el próximo año y cómo se consultará a las familias antes de asignar o cambiar las horas?',
    zh: '明年喘息照护时数会减少吗？在分配或调整时数之前，会如何征求家庭的意见？'
  }
};

/** The questions in a prompt are its JSON lines, wherever an admin's own wording puts them. */
function jsonLines(prompt) {
  return String(prompt || '').split('\n').map((line) => {
    const text = line.trim();
    if (text.charAt(0) !== '{' || text.charAt(text.length - 1) !== '}') return null;
    try { return JSON.parse(text); } catch (err) { return null; }
  }).filter(Boolean);
}

function demoGemini(call) {
  if (call.schema.properties.assignments) {
    const assignments = [];
    const used = new Set();
    jsonLines(call.prompt).filter((q) => q.id && q.text).forEach(({ id, text }) => {
      const q = QUESTIONS.find((row) => row[0] === text);
      if (!q || !q[3]) return;
      used.add(q[3]);
      const row = { id, topic: q[3], language: q[1], translation: q[2] || q[0] };
      if (call.schema.properties.assignments.items.properties.logistics) {
        row.logistics = /\b(parking|room|rooms|wifi|agenda|schedule|food|lunch|signage|interpreter|interpretation|accessible|accessibility|toilets?|quiet)\b/i.test(text);
      }
      assignments.push(row);
    });
    return { assignments, labels: Array.from(used).map((topic) => ({ topic, translations: LABELS[topic] })) };
  }
  if (call.schema.properties.question) return MERGED;
  return { ok: true };
}

function logoDataUrl() {
  const file = path.join(__dirname, 'demo-logo.png');
  return fs.existsSync(file) ? 'data:image/png;base64,' + fs.readFileSync(file).toString('base64') : '';
}

/** options.fixedTime: build the demo at this moment (ms), so screenshots are the same every run. */
function buildDemo(options) {
  options = options || {};
  const h = createApp({ owner: USERS.owner }).install({ moderators: ['maria@example.org', 'jin@example.org'], admins: ['alex@example.org'] });
  h.env.gemini = demoGemini;
  h.env.geminiModels = { models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-pro'].map((name) => ({
    name: 'models/' + name, displayName: name.replace(/-/g, ' '), supportedGenerationMethods: ['generateContent']
  })) };
  // Start the demo just before now, so pages comparing against the real clock look normal.
  h.env.clock.now = (options.fixedTime || Date.now()) - 6 * 60 * 1000;
  h.app.saveBrand({
    orgName: 'Community Family Network',
    accent: '#5b3f9a',
    welcome: 'Thank you for joining tonight\'s family resource night.',
    footer: 'communityfamilynetwork.example · Questions are anonymous',
    roomBgDark: '#17122a',
    roomBgLight: '#ffffff'
  });
  const logo = logoDataUrl();
  if (logo) h.app.saveLogo(logo);

  const now = h.env.clock.now;
  const hour = 3600 * 1000;
  const mods = ['maria@example.org', 'jin@example.org'];

  // Four languages: the most an event can have, so page layouts are tested at their fullest.
  const conference = h.app.saveEvent({ name: 'Fall Family Conference 2026', welcome: 'Welcome to the Fall Family Conference.', languages: ['ko', 'es', 'zh'] }).savedEventId;
  const partner = h.app.saveEvent({ name: 'Valley School District Partner Night', orgName: 'Valley School District', accent: '#1f6fb2' }).savedEventId;

  const ended = h.session({ name: 'Spring Town Hall', access: 'room', active: true, moderators: mods, emailOnEnd: true });
  h.ask(ended, h.join(ended), 'What is the plan for summer programs this year?');
  h.advance(60);
  h.app.endSession(ended.id, h.app.getSession_(ended.id).name);

  h.session({ eventId: conference, name: 'Parent Support Circle (Spanish)', heading: 'Preguntas para el círculo de apoyo', access: 'link', theme: 'light',
              moderators: ['maria@example.org'], scheduledStart: now + 6 * 24 * hour, scheduledEnd: now + 6 * 24 * hour + 2 * hour });
  h.session({ eventId: partner, name: 'Panel: transitions to middle school', access: 'link', moderators: ['jin@example.org'] });

  const live = h.session({ eventId: conference, name: 'Family Resource Night — September', heading: 'Questions for tonight\'s panel', access: 'room',
                           theme: 'dark', moderators: mods, emailOnEnd: true, active: true, scheduledEnd: now + 3 * hour });
  h.app.saveSession({ id: live.id, name: live.name, heading: live.heading, access: 'room', theme: 'dark', moderators: mods,
    emailOnEnd: true, scheduledEnd: live.scheduledEnd,
    prepared: ['What new programs are planned for teens and young adults next year?',
               'How can families give feedback between meetings?'] });
  QUESTIONS.forEach((q) => { h.ask(live, h.join(live), q[0]); h.advance(20); });
  h.ask(live, h.join(live), 'Follow my page for free giveaways!!!');
  h.app.clusterAll_();
  h.as(USERS.mod);
  h.app.setStatus(live.id, [h.questions().rows.find((r) => /giveaways/.test(r[3]))[0]], 'dismissed');
  h.app.setStatus(live.id, [h.questions().rows.find((r) => r[3] === QUESTIONS[9][0])[0]], 'answered');
  h.app.mergeTopic(live.id, 'Respite care hours');
  h.app.setNowAnswering(live.id, 'Respite care hours');
  // Approved for phones; "Sensory-friendly events" is left waiting for approval.
  ['Respite care hours', 'IEP and school support', 'Evaluation waitlists'].forEach((t) => h.app.setTopicShown(live.id, t, true));

  // A few participants support topics.
  h.as('');
  const votes = [['Respite care hours', 9], ['IEP and school support', 6], ['Evaluation waitlists', 4]];
  votes.forEach(([topic, n]) => {
    for (let i = 0; i < n; i++) h.app.meToo(live.id, h.join(live).deviceId, topic);
  });
  h.advance(30);
  h.as(USERS.owner);
  h.app.runHealthCheck();
  return { h, live };
}

// ------------------------------------------------------------ server

function shim(as, params) {
  return '<script>(function(){' +
    'var AS=' + JSON.stringify(as) + ',PARAMS=' + JSON.stringify(params) + ';' +
    'function runner(h){return new Proxy({},{get:function(t,name){' +
    'if(name==="withSuccessHandler")return function(f){return runner(Object.assign({},h,{ok:f}));};' +
    'if(name==="withFailureHandler")return function(f){return runner(Object.assign({},h,{fail:f}));};' +
    'if(name==="withUserObject")return function(){return runner(h);};' +
    'return function(){var args=[].slice.call(arguments);' +
    'fetch("/rpc",{method:"POST",body:JSON.stringify({fn:name,args:args,as:AS})}).then(function(r){return r.json();})' +
    '.then(function(res){if(res.error){if(h.fail)h.fail(new Error(res.error));}else if(h.ok){h.ok(res.value);}});};}});}' +
    'window.google={script:{run:runner({}),url:{getLocation:function(cb){cb({parameter:PARAMS});}}}};' +
    // ?lang=ko presets the participant page language, as a returning visitor would have it.
    'if(PARAMS.lang){try{localStorage.setItem("qd.lang",PARAMS.lang);}catch(e){}}' +
    // #click=a,b clicks elements by id (or tab name) after load, for screenshots.
    'window.addEventListener("load",function(){var m=location.hash.match(/click=([^&]+)/);if(!m)return;' +
    'm[1].split(",").forEach(function(id,i){setTimeout(function(){var el=document.getElementById(id)||document.querySelector("[data-tab=\\""+id+"\\"]");if(el)el.click();},600*(i+1));});});' +
    '})();</script>';
}

/**
 * options.rpcDelayMs slows every server call, to prove pages don't wait for the server.
 * options.rpcReplyDelay(fn, n) → ms, per call (n counts calls to fn): the call runs at once but
 * its answer is held back, so answers can arrive out of order the way they can from Apps Script.
 */
function serve(port, options) {
  options = options || {};
  const { h, live } = buildDemo(options);
  const calls = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { fn, args, as } = JSON.parse(body);
        let out;
        try {
          if (!/^[A-Za-z]+$/.test(fn) || typeof h.app[fn] !== 'function') throw new Error('Unknown function ' + fn);
          h.env.activeUser = USERS[as] !== undefined ? USERS[as] : '';
          out = { value: h.app[fn].apply(null, args) };
        } catch (err) {
          out = { error: err.message };
        }
        const reply = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out === undefined ? {} : out));
        };
        calls[fn] = (calls[fn] || 0) + 1;
        const wait = options.rpcReplyDelay ? options.rpcReplyDelay(fn, calls[fn]) : options.rpcDelayMs;
        if (wait) setTimeout(reply, wait); else reply();
      });
      return;
    }
    if (url.pathname === '/demo') {
      // Handy links, including a fresh room token for the participant page.
      h.env.activeUser = USERS.owner;
      const t = new URL(h.app.getRoomScreen(live.id).url).searchParams.get('t');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: live.id, token: t }));
      return;
    }
    if (url.pathname === '/phone') {
      // Headless Chrome won't size a window below ~500px, so phone shots render in a 390px frame.
      const src = url.searchParams.get('src') || '/';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // Centered, because macOS sips crops around the center.
      res.end('<!doctype html><html><body style="margin:0;background:#fff;display:flex;justify-content:center">' +
        '<iframe src="' + src.replace(/"/g, '&quot;') + '" width="390" height="844" style="border:0;display:block"></iframe></body></html>');
      return;
    }
    if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }

    const params = Object.fromEntries(url.searchParams.entries());
    const as = params.as || 'anon';
    delete params.as;
    h.env.activeUser = USERS[as] !== undefined ? USERS[as] : '';
    const page = h.app.doGet({ parameter: params });
    const html = fs.readFileSync(path.join(ROOT, page.file), 'utf8')
      .replace('<?!= boot ?>', page.boot)
      .replace('<?!= styles ?>', () => page.styles)
      .replace('<?!= scripts ?>', () => page.scripts)
      .replace('<head>', '<head><title>' + page.title + '</title>' + shim(as, params));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, h, live })));
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  serve(port).then(({ live }) => {
    const base = 'http://localhost:' + port;
    console.log('Question Desk preview with demo data:');
    console.log('  Landing page       ' + base + '/');
    console.log('  Admin              ' + base + '/?view=admin&as=owner');
    console.log('  Facilitator queue  ' + base + '/?view=moderate&s=' + live.id + '&as=mod');
    console.log('  Room screen        ' + base + '/?view=present&s=' + live.id + '&as=owner');
    console.log('  Participant page   ' + base + '/demo  (gives a fresh token), then /?s=' + live.id + '&t=<token>');
  });
}

module.exports = { serve, buildDemo, USERS };
