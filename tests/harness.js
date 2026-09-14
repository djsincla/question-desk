'use strict';
/**
 * Runs the real Code.js against in-memory fakes of the Apps Script services it
 * uses. Each createApp() call is a fresh, isolated install with its own clock,
 * properties, cache, spreadsheet, outbox and Gemini stub.
 *
 * The fakes enforce the Apps Script limits that have bitten this project or
 * could: 9KB per property value, 500KB of properties in total, and the
 * spreadsheet's habit of evaluating strings that start with "=".
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
const FUNCTION_NAMES = Array.from(SOURCE.matchAll(/^function ([A-Za-z0-9_]+)\s*\(/gm), (m) => m[1]);

const DEPLOY_URL = 'https://script.google.com/a/macros/example.org/s/DEPLOYID/exec';
const PUBLIC_URL = 'https://script.google.com/macros/s/DEPLOYID/exec';
const OWNER = 'owner@example.org';

function createApp(options) {
  options = options || {};
  const clock = { now: Date.UTC(2026, 8, 12, 18, 0, 0) };
  const env = {
    clock,
    owner: options.owner || OWNER,
    activeUser: options.activeUser === undefined ? (options.owner || OWNER) : options.activeUser,
    outbox: [],
    geminiCalls: [],
    lockDepth: 0,
    rangeListCalls: 0,
    unlockedAppends: [],   // rows appended to Questions without the script lock (must stay empty)
    gemini: defaultGemini,
    mailQuota: 100,
    faviconError: null,
    propertyReads: 0,
    opens: 0,
    sheetReads: 0,
    triggers: [],
    logs: []
  };

  // ---------------------------------------------------------- Date
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  }

  // ---------------------------------------------------------- properties
  const store = new Map();
  const scriptProperties = {
    getProperty: (k) => { env.propertyReads++; return store.has(k) ? store.get(k) : null; },
    setProperty(k, v) {
      v = String(v);
      if (Buffer.byteLength(v) > 9000) throw new Error('Property value too large: ' + k + ' (' + Buffer.byteLength(v) + ' bytes)');
      store.set(k, v);
      let total = 0;
      store.forEach((val, key) => { total += Buffer.byteLength(key) + Buffer.byteLength(val); });
      if (total > 500000) throw new Error('Property store over 500KB');
      return scriptProperties;
    },
    setProperties(obj) {
      Object.keys(obj).forEach((k) => scriptProperties.setProperty(k, obj[k]));
      return scriptProperties;
    },
    deleteProperty(k) { store.delete(k); return scriptProperties; },
    getProperties() {
      const out = {};
      store.forEach((v, k) => { out[k] = v; });
      return out;
    }
  };

  // ---------------------------------------------------------- cache
  const cacheStore = new Map();
  const scriptCache = {
    get(k) {
      const hit = cacheStore.get(k);
      if (!hit) return null;
      if (hit.expires <= clock.now) { cacheStore.delete(k); return null; }
      return hit.value;
    },
    remove(k) { cacheStore.delete(k); },
    put(k, v, ttlSeconds) {
      if (k.length > 250) throw new Error('Cache key too long');
      if (String(v).length > 100000) throw new Error('Cache value over 100KB: ' + k);
      cacheStore.set(k, { value: String(v), expires: clock.now + (ttlSeconds || 600) * 1000 });
    }
  };

  // ---------------------------------------------------------- spreadsheet
  const spreadsheets = new Map();

  function makeSpreadsheet(name) {
    const ss = {
      id: 'sheet-' + (spreadsheets.size + 1),
      name,
      sheets: new Map(),
      getId() { return ss.id; },
      getUrl() { return 'https://docs.google.com/spreadsheets/d/' + ss.id; },
      getSheetByName(n) { return ss.sheets.get(n) || null; },
      insertSheet(n) { const sh = makeSheet(n); ss.sheets.set(n, sh); return sh; }
    };
    spreadsheets.set(ss.id, ss);
    return ss;
  }

  function makeSheet(name) {
    const sheet = {
      name,
      rows: [],
      formulas: [],
      width() { return sheet.rows.reduce((w, r) => Math.max(w, r.length), 0); },
      store(value, row, col) {
        // Sheets strips a leading apostrophe and stores the rest as text; an
        // unguarded leading "=" becomes a formula, which must never happen.
        if (typeof value === 'string' && value.charAt(0) === "'") return value.slice(1);
        if (typeof value === 'string' && value.charAt(0) === '=') sheet.formulas.push({ row, col, value });
        return value;
      },
      appendRow(values) {
        if (sheet.name === 'Questions' && env.lockDepth === 0 && values[0] !== 'ID') env.unlockedAppends.push(values);
        const r = sheet.rows.length + 1;
        values.forEach((v) => {
          if (typeof v === 'string' && v.length > 50000) throw new Error('Cell over 50,000 characters');
        });
        sheet.rows.push(values.map((v, i) => sheet.store(v, r, i + 1)));
        return sheet;
      },
      getLastRow() { return sheet.rows.length; },
      getMaxRows() { return Math.max(1000, sheet.rows.length); },
      insertRowsAfter() { return sheet; },
      getName() { return sheet.name; },
      deleteRow(row) { sheet.rows.splice(row - 1, 1); return sheet; },
      deleteRows(row, howMany) { sheet.rows.splice(row - 1, howMany); return sheet; },
      setFrozenRows() { return sheet; },
      getDataRange() {
        env.sheetReads++;
        const w = sheet.width();
        return { getValues: () => sheet.rows.map((r) => pad(r, w)) };
      },
      // A RangeList of single cells in A1 notation ("E5"), as setCells_ uses.
      getRangeList(a1s) {
        env.rangeListCalls++;
        const cells = a1s.map((a1) => {
          const m = /^([A-Z])(\d+)$/.exec(a1);
          if (!m) throw new Error('Unsupported A1 cell: ' + a1);
          return [Number(m[2]), m[1].charCodeAt(0) - 64];
        });
        return { setValue(v) { cells.forEach(([row, col]) => setCell(row, col, v)); return this; } };
      },
      getRange(a, b, c, d) {
        if (typeof a === 'string') return { setNumberFormat() { return this; } };
        const row = a, col = b, numRows = c || 1, numCols = d || 1;
        return {
          getValue: () => cell(row, col),
          setValue: (v) => { setCell(row, col, v); },
          getValues: () => {
            const out = [];
            for (let i = 0; i < numRows; i++) {
              const line = [];
              for (let j = 0; j < numCols; j++) line.push(cell(row + i, col + j));
              out.push(line);
            }
            return out;
          },
          setValues: (values) => {
            values.forEach((line, i) => line.forEach((v, j) => setCell(row + i, col + j, v)));
          }
        };
      }
    };
    function cell(row, col) {
      const r = sheet.rows[row - 1];
      return r && r[col - 1] !== undefined ? r[col - 1] : '';
    }
    function setCell(row, col, v) {
      while (sheet.rows.length < row) sheet.rows.push([]);
      const r = sheet.rows[row - 1];
      while (r.length < col) r.push('');
      r[col - 1] = sheet.store(v, row, col);
    }
    return sheet;
  }

  function pad(r, w) {
    const out = r.slice();
    while (out.length < w) out.push('');
    return out;
  }

  // ---------------------------------------------------------- services
  const services = {
    Date: FakeDate,
    console: {
      log: (...a) => env.logs.push(a.join(' ')),
      error: (...a) => env.logs.push('ERROR ' + a.join(' '))
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    CacheService: { getScriptCache: () => scriptCache },
    // Tracks whether the script lock is held, so tests can prove questions are only written under it.
    LockService: { getScriptLock: () => ({
      waitLock() { env.lockDepth++; },
      tryLock() { env.lockDepth++; return true; },
      releaseLock() { env.lockDepth = Math.max(0, env.lockDepth - 1); }
    }) },
    Session: {
      getActiveUser: () => ({ getEmail: () => env.activeUser || '' }),
      getEffectiveUser: () => ({ getEmail: () => env.owner }),
      getScriptTimeZone: () => 'America/Los_Angeles'
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      // Real time-zone math for the patterns the app uses in CSVs; other patterns stay ISO.
      formatDate: (date, tz, pattern) => {
        if (pattern !== 'yyyy-MM-dd HH:mm' && pattern !== 'yyyy-MM-dd') return new RealDate(date.getTime()).toISOString();
        const parts = zoneParts(date.getTime(), tz);
        return parts.y + '-' + parts.mo + '-' + parts.d + (pattern === 'yyyy-MM-dd' ? '' : ' ' + parts.h + ':' + parts.mi);
      },
      parseDate: (text, tz, pattern) => {
        const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
        if (pattern !== 'yyyy-MM-dd HH:mm' || !m) throw new Error('Unparseable date: ' + text);
        const wall = RealDate.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        let guess = wall;
        for (let i = 0; i < 2; i++) {
          const p = zoneParts(guess, tz);
          const shown = RealDate.UTC(+p.y, +p.mo - 1, +p.d, +p.h, +p.mi);
          guess += wall - shown;
        }
        return new RealDate(guess);
      },
      newBlob: (data, contentType, name) => ({ data, contentType, name, getDataAsString: () => data })
    },
    SpreadsheetApp: {
      openById: (id) => {
        env.opens++;
        const ss = spreadsheets.get(id);
        if (!ss) throw new Error('No spreadsheet ' + id);
        return ss;
      },
      create: (name) => makeSpreadsheet(name),
      flush: () => {}
    },
    MailApp: {
      sendEmail: (message) => {
        if (env.mailQuota <= 0) throw new Error('Service invoked too many times: email');
        env.mailQuota -= String(message.to).split(',').length;
        env.outbox.push(message);
      },
      getRemainingDailyQuota: () => env.mailQuota
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        const body = JSON.parse(opts.payload);
        const call = { url, prompt: body.contents[0].parts[0].text, schema: body.generationConfig.responseSchema };
        env.geminiCalls.push(call);
        const result = env.gemini(call);
        if (result && result.status) {
          return { getResponseCode: () => result.status, getContentText: () => result.text || '' };
        }
        const text = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] });
        return { getResponseCode: () => 200, getContentText: () => text };
      }
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => env.deployUrl || DEPLOY_URL }),
      getProjectTriggers: () => env.triggers.slice(),
      deleteTrigger: (t) => { env.triggers = env.triggers.filter((x) => x !== t); },
      newTrigger: (handler) => {
        const t = { handler, getHandlerFunction: () => handler, getUniqueId: () => 'trigger-' + handler };
        const chain = { timeBased: () => chain, everyMinutes: (n) => { t.minutes = n; return chain; }, create: () => { env.triggers.push(t); return t; } };
        return chain;
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => {
        const out = { text, mime: null, setMimeType(m) { out.mime = m; return out; }, json: () => JSON.parse(text) };
        return out;
      }
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile: (file) => {
        const template = {
          evaluate: () => {
            const out = {
              file,
              boot: template.boot,
              data: JSON.parse(template.boot),
              title: '',
              setTitle(t) { out.title = t; return out; },
              addMetaTag() { return out; },
              setXFrameOptionsMode(mode) { out.xframe = mode; return out; },
              setFaviconUrl(url) {
                if (env.faviconError) throw new Error(env.faviconError);
                out.favicon = url;
                return out;
              }
            };
            return out;
          }
        };
        return template;
      },
      createHtmlOutputFromFile: () => ({ getContent: () => '' })
    }
  };

  const names = Object.keys(services);
  const factory = new Function(...names,
    SOURCE + '\nreturn {' + FUNCTION_NAMES.join(',') + ', APP: APP, CONFIG: CONFIG, COLS: COLS, HEADERS: HEADERS, TOPIC_HEADERS: TOPIC_HEADERS};');
  const raw = factory(...names.map((n) => services[n]));
  // Each call from a test is one Apps Script execution: globals (EXEC_) start fresh.
  const app = {};
  Object.keys(raw).forEach((k) => {
    app[k] = typeof raw[k] === 'function' && k !== 'resetExecution_'
      ? function () { raw.resetExecution_(); return raw[k].apply(null, arguments); }
      : raw[k];
  });

  // ---------------------------------------------------------- helpers
  const h = {
    app,
    env,
    props: scriptProperties,
    cache: scriptCache,
    as(email) { env.activeUser = email; return h; },
    anonymous() { env.activeUser = ''; return h; },
    advance(seconds) { clock.now += seconds * 1000; return h; },
    spreadsheet() { return spreadsheets.get(scriptProperties.getProperty('SHEET_ID')); },
    // The Questions sheet as it is once buffered submissions are written (flushInbox_).
    questions() { app.flushInbox_(); return h.spreadsheet().getSheetByName('Questions'); },
    questionsRaw() { return h.spreadsheet().getSheetByName('Questions'); },
    topics() { return h.spreadsheet().getSheetByName('Topics'); },
    assets() { return h.spreadsheet().getSheetByName('Assets'); },

    /** POSTs to doPost the way scripts/loadtest.js does. */
    post(body) {
      const was = env.activeUser;
      env.activeUser = '';
      const out = app.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      env.activeUser = was;
      return out.json();
    },

    /** Builds the pre-sessions (v3) spreadsheet layout, before setUp has run. */
    legacySheet(rows) {
      const ss = makeSpreadsheet('Question Desk — submissions');
      scriptProperties.setProperty('SHEET_ID', ss.getId());
      const sheet = ss.insertSheet('Questions');
      sheet.appendRow(['ID', 'Submitted', 'Device', 'Question', 'Status', 'Topic', 'Language', 'Translation']);
      rows.forEach((r) => sheet.appendRow(r));
      return sheet;
    },

    /** Fresh install: setUp as owner, Gemini key set, moderators on the roster. */
    install(opts) {
      opts = opts || {};
      const was = env.activeUser;
      env.activeUser = env.owner;
      app.setUp();
      scriptProperties.setProperty('GEMINI_API_KEY', 'test-key');
      (opts.moderators || []).forEach((m) => app.addPerson('moderator', m));
      (opts.admins || []).forEach((m) => app.addPerson('admin', m));
      env.activeUser = was;
      return h;
    },

    /** Creates a session as the owner and returns the stored session object. */
    session(fields) {
      const was = env.activeUser;
      env.activeUser = env.owner;
      const before = new Set(app.allSessions_().map((s) => s.id));
      app.saveSession(Object.assign({ name: 'Test session', access: 'room', theme: 'dark', maxLength: 300 }, fields || {}));
      const created = app.allSessions_().find((s) => !before.has(s.id));
      if (fields && fields.active) app.setSessionActive(created.id, true);
      env.activeUser = was;
      return app.getSession_(created.id);
    },

    /** The room screen key, as the Admin page's links carry it. */
    screenKey(session) {
      const was = env.activeUser;
      env.activeUser = env.owner;
      const key = app.screenKeyFor_(app.getSession_(session.id || session));
      env.activeUser = was;
      return key;
    },

    /** Joins a session the way a phone does and returns the device id. */
    join(session) {
      const was = env.activeUser;
      let credential;
      if (session.access === 'link') {
        credential = app.getSession_(session.id).linkKey;
      } else {
        env.activeUser = env.owner;
        credential = new URL(app.getRoomScreen(session.id).url).searchParams.get('t');
      }
      env.activeUser = '';
      const res = app.claimDevice(session.id, credential);
      env.activeUser = was;
      if (!res.ok) throw new Error('join failed: ' + res.reason);
      return { deviceId: res.deviceId, credential };
    },

    /** Submits as an anonymous participant. */
    ask(session, device, text) {
      const was = env.activeUser;
      env.activeUser = '';
      const res = app.submitQuestion(session.id, device.deviceId, text, device.credential);
      env.activeUser = was;
      return res;
    }
  };
  return h;
}

/** Stub Gemini: labels each question by its first word, translation = text. */
function zoneParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const out = {};
  f.formatToParts(new Date(ms)).forEach((p) => { out[p.type] = p.value; });
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute };
}

function defaultGemini(call) {
  if (call.schema.properties.assignments) {
    const lines = call.prompt.split('New questions:\n')[1].split('\n\nDo not invent')[0].split('\n');
    const assignments = lines.filter(Boolean).map((line) => {
      const { id, text } = JSON.parse(line);
      const out = { id, topic: 'About ' + text.split(' ')[0].toLowerCase(), language: 'English', translation: text };
      // Per-question translations when asked (prepared questions, in the session's languages).
      const item = call.schema.properties.assignments.items.properties;
      if (item.translations) out.translations = Object.fromEntries(Object.keys(item.translations.properties).map((c) => [c, '[' + c + '] ' + text]));
      return out;
    });
    const topics = Array.from(new Set(assignments.map((a) => a.topic)));
    return {
      assignments,
      // Translate into whichever languages the request asks for (the session's languages).
      labels: topics.map((topic) => {
        const wanted = call.schema.properties.labels ? Object.keys(call.schema.properties.labels.items.properties.translations.properties) : [];
        return { topic, translations: Object.fromEntries(wanted.map((c) => [c, '[' + c + '] ' + topic])) };
      })
    };
  }
  if (call.schema.properties.question) {
    const wanted = call.schema.properties.translations ? Object.keys(call.schema.properties.translations.properties) : [];
    return { question: 'What does everyone want to know?', translations: Object.fromEntries(wanted.map((c) => [c, '[' + c + '] merged'])) };
  }
  return { ok: true };
}

module.exports = { createApp, OWNER, DEPLOY_URL, PUBLIC_URL };
