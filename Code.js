/**
 * Question Desk
 * Anonymous audience Q&A for Google Workspace, with Gemini topic roll-up.
 *
 * Three views, all served from one deployment:
 *   ?view=ask       (default) participant submission page
 *   ?view=present   big screen: rotating QR code
 *   ?view=moderate  facilitator queue, grouped by topic
 *
 * Run setUp() once from the editor before deploying.
 */

const CONFIG = {
  sheetName: 'Questions',
  model: 'gemini-3.5-flash',      // gemini-3.1-flash-lite is cheaper if cost matters
  moderatorLanguage: 'English',   // topics and translations are written in this
  maxLength: 300,
  cooldownSeconds: 300,           // per device
  roomLimitPerMinute: 15,         // whole-session intake cap
  entryTokenSeconds: 150,         // how often the QR rotates
  deviceTokenSeconds: 21600,      // 6h — CacheService maximum
  requireEntryToken: true,        // false = plain static QR, no room scoping
  clusterBatchSize: 25
};

const COLS = {
  id: 1, submitted: 2, device: 3, text: 4,
  status: 5, topic: 6, lang: 7, translation: 8
};

// ---------------------------------------------------------------- routing

function doGet(e) {
  const view = (e && e.parameter && e.parameter.view) || 'ask';

  if (view === 'moderate' || view === 'present') {
    if (!isModerator_()) return page_('Denied', 'Denied.html');
    return page_(view === 'present' ? 'Scan to ask' : 'Question queue',
                 view === 'present' ? 'Present.html' : 'Moderate.html');
  }
  return page_('Ask a question', 'Ask.html');
}

function page_(title, file) {
  return HtmlService.createTemplateFromFile(file)
    .evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function webAppUrl() {
  return ScriptApp.getService().getUrl();
}

// ---------------------------------------------------------------- entry tokens

/**
 * Current room token. Rotates on read once expired; the previous token stays
 * valid for one extra window so a scan mid-rotation doesn't fail.
 */
function getEntryToken() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const issued = Number(props.getProperty('TOKEN_ISSUED') || 0);
  let current = props.getProperty('TOKEN_CURRENT');

  if (!current || now - issued > CONFIG.entryTokenSeconds * 1000) {
    const previous = current || '';
    current = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    props.setProperties({
      TOKEN_PREVIOUS: previous,
      TOKEN_CURRENT: current,
      TOKEN_ISSUED: String(now)
    });
  }
  return { token: current, rotateInSeconds: CONFIG.entryTokenSeconds };
}

function validEntryToken_(token) {
  if (!CONFIG.requireEntryToken) return true;
  if (!token) return false;
  const props = PropertiesService.getScriptProperties();
  return token === props.getProperty('TOKEN_CURRENT') ||
         token === props.getProperty('TOKEN_PREVIOUS');
}

/**
 * Exchange a short-lived room token for a device token the browser keeps.
 * Called once, when the participant page first loads after a scan.
 */
function claimDevice(entryToken) {
  if (!validEntryToken_(entryToken)) {
    return { ok: false, reason: 'expired' };
  }
  const deviceId = Utilities.getUuid();
  CacheService.getScriptCache().put('dev:' + deviceId, '1', CONFIG.deviceTokenSeconds);
  return { ok: true, deviceId: deviceId };
}

// ---------------------------------------------------------------- submission

function getSessionState(deviceId) {
  const props = PropertiesService.getScriptProperties();
  return {
    open: props.getProperty('BOARD_OPEN') !== 'false',
    heading: props.getProperty('SESSION_HEADING') || 'Questions for the panel',
    cooldownRemaining: deviceId ? cooldownRemaining_(deviceId) : 0,
    maxLength: CONFIG.maxLength
  };
}

function submitQuestion(deviceId, text, entryToken) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('BOARD_OPEN') === 'false') {
    return { ok: false, reason: 'closed' };
  }

  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 5) return { ok: false, reason: 'tooShort' };
  if (clean.length > CONFIG.maxLength) return { ok: false, reason: 'tooLong' };

  const cache = CacheService.getScriptCache();
  if (!deviceId || !cache.get('dev:' + deviceId)) {
    if (!validEntryToken_(entryToken)) return { ok: false, reason: 'expired' };
  }

  const waiting = cooldownRemaining_(deviceId);
  if (waiting > 0) return { ok: false, reason: 'cooldown', waitSeconds: waiting };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return { ok: false, reason: 'busy' };
  }

  try {
    if (!roomBudgetAvailable_()) return { ok: false, reason: 'busy' };

    const sheet = questionSheet_();
    const id = Utilities.getUuid().slice(0, 8);
    sheet.appendRow([id, new Date(), deviceId || 'unknown', clean, 'new', '', '', '']);
    cache.put('cool:' + deviceId, '1', CONFIG.cooldownSeconds);
    return { ok: true, id: id, cooldownSeconds: CONFIG.cooldownSeconds };
  } finally {
    lock.releaseLock();
  }
}

function cooldownRemaining_(deviceId) {
  if (!deviceId) return 0;
  const stamp = CacheService.getScriptCache().get('cool:' + deviceId);
  if (!stamp) return 0;
  // Cache TTL does the expiry; we only need to know that it is still present.
  // The client counts down locally from the value returned at submit time.
  return 1;
}

/** Whole-room intake cap, so no single device can flood the queue. */
function roomBudgetAvailable_() {
  const cache = CacheService.getScriptCache();
  const bucket = 'room:' + Math.floor(Date.now() / 60000);
  const used = Number(cache.get(bucket) || 0);
  if (used >= CONFIG.roomLimitPerMinute) return false;
  cache.put(bucket, String(used + 1), 120);
  return true;
}

// ---------------------------------------------------------------- moderation

function getBoard() {
  if (!isModerator_()) throw new Error('Not a moderator.');

  const rows = questionSheet_().getDataRange().getValues().slice(1);
  const topics = {};
  const loose = [];

  rows.forEach(function (r) {
    if (r[COLS.status - 1] === 'dismissed') return;
    const item = {
      id: r[COLS.id - 1],
      text: r[COLS.text - 1],
      lang: r[COLS.lang - 1] || '',
      translation: r[COLS.translation - 1] || '',
      status: r[COLS.status - 1],
      submitted: r[COLS.submitted - 1] ? new Date(r[COLS.submitted - 1]).getTime() : 0
    };
    const topic = r[COLS.topic - 1];
    if (!topic) { loose.push(item); return; }
    if (!topics[topic]) topics[topic] = [];
    topics[topic].push(item);
  });

  const grouped = Object.keys(topics).map(function (name) {
    return { topic: name, questions: topics[name], count: topics[name].length };
  }).sort(function (a, b) { return b.count - a.count; });

  const props = PropertiesService.getScriptProperties();
  return {
    topics: grouped,
    unsorted: loose,
    open: props.getProperty('BOARD_OPEN') !== 'false',
    merged: JSON.parse(props.getProperty('MERGED') || '{}')
  };
}

function setStatus(ids, status) {
  if (!isModerator_()) throw new Error('Not a moderator.');
  const sheet = questionSheet_();
  const values = sheet.getDataRange().getValues();
  const wanted = {};
  ids.forEach(function (id) { wanted[id] = true; });

  for (let i = 1; i < values.length; i++) {
    if (wanted[values[i][COLS.id - 1]]) {
      sheet.getRange(i + 1, COLS.status).setValue(status);
    }
  }
  return getBoard();
}

function setBoardOpen(open) {
  if (!isModerator_()) throw new Error('Not a moderator.');
  PropertiesService.getScriptProperties().setProperty('BOARD_OPEN', open ? 'true' : 'false');
  return getBoard();
}

// ---------------------------------------------------------------- Gemini

/**
 * Assigns a topic to every question that doesn't have one yet.
 * Existing topic names are passed in so labels stay stable between runs
 * instead of re-shuffling under the facilitator's eyes.
 */
function clusterQuestions() {
  const sheet = questionSheet_();
  const values = sheet.getDataRange().getValues();
  const pending = [];
  const existing = {};

  for (let i = 1; i < values.length; i++) {
    const topic = values[i][COLS.topic - 1];
    if (topic) { existing[topic] = true; continue; }
    if (values[i][COLS.status - 1] === 'dismissed') continue;
    pending.push({ row: i + 1, id: values[i][COLS.id - 1], text: values[i][COLS.text - 1] });
    if (pending.length >= CONFIG.clusterBatchSize) break;
  }
  if (!pending.length) return 0;

  const lang = CONFIG.moderatorLanguage;

  const prompt = [
    'You are preparing audience questions from a live meeting for a facilitator.',
    'Questions arrive in mixed languages. Do three things for each one.',
    '',
    '1. Identify the language it was written in.',
    '2. Translate it into ' + lang + '. Translate faithfully: keep the asker\'s',
    '   tone, keep criticism as sharp as it was written, and do not smooth over',
    '   or soften anything. If a phrase has no clean equivalent, translate it',
    '   plainly rather than paraphrasing it away. If it is already in ' + lang + ',',
    '   repeat it unchanged.',
    '3. Assign a topic label so the facilitator can answer each theme once.',
    '',
    'Topic labels must always be written in ' + lang + ', whatever language the',
    'question was asked in, so that questions on the same theme group together',
    'across languages. Reuse an existing label verbatim when a question fits it.',
    'Otherwise write a new label of at most five words in plain language.',
    '',
    'Existing topic labels:',
    Object.keys(existing).length ? Object.keys(existing).join('\n') : '(none yet)',
    '',
    'New questions:',
    pending.map(function (q) { return q.id + ': ' + q.text; }).join('\n'),
    '',
    'Do not invent questions and do not answer them.'
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: {
      assignments: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            topic: { type: 'STRING' },
            language: { type: 'STRING', description: 'English name of the source language' },
            translation: { type: 'STRING' }
          },
          required: ['id', 'topic', 'language', 'translation']
        }
      }
    },
    required: ['assignments']
  };

  const result = callGemini_(prompt, schema);
  if (!result || !result.assignments) return 0;

  const byId = {};
  pending.forEach(function (q) { byId[q.id] = q.row; });

  result.assignments.forEach(function (a) {
    const row = byId[a.id];
    if (!row) return;
    sheet.getRange(row, COLS.topic, 1, 3)
      .setValues([[a.topic, a.language || '', a.translation || '']]);
  });
  return result.assignments.length;
}

/** Collapses one topic's questions into a single question to read aloud. */
function mergeTopic(topic) {
  if (!isModerator_()) throw new Error('Not a moderator.');

  const rows = questionSheet_().getDataRange().getValues().slice(1)
    .filter(function (r) {
      return r[COLS.topic - 1] === topic && r[COLS.status - 1] !== 'dismissed';
    })
    .map(function (r) {
      const source = r[COLS.translation - 1] || r[COLS.text - 1];
      const from = r[COLS.lang - 1];
      return '- ' + source + (from ? '  [asked in ' + from + ']' : '');
    });

  if (!rows.length) return { ok: false };

  const prompt = [
    'These audience questions were all asked about "' + topic + '", by people',
    'writing in different languages.',
    'Write one question in ' + CONFIG.moderatorLanguage + ' that covers what they',
    'are collectively asking. Keep the audience\'s own concerns and specifics.',
    'Do not soften criticism, and do not add anything nobody asked.',
    'If they are not actually asking the same thing, say so instead of forcing',
    'them together. One sentence, under 40 words.',
    '',
    rows.join('\n')
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: { question: { type: 'STRING' } },
    required: ['question']
  };

  const result = callGemini_(prompt, schema);
  if (!result || !result.question) return { ok: false };

  const props = PropertiesService.getScriptProperties();
  const merged = JSON.parse(props.getProperty('MERGED') || '{}');
  merged[topic] = result.question;
  props.setProperty('MERGED', JSON.stringify(merged));
  return { ok: true, question: result.question };
}

function callGemini_(prompt, schema) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set in Script Properties.');

  const response = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.model + ':generateContent',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      })
    }
  );

  if (response.getResponseCode() !== 200) {
    console.error('Gemini ' + response.getResponseCode() + ': ' + response.getContentText());
    return null;
  }

  try {
    const body = JSON.parse(response.getContentText());
    return JSON.parse(body.candidates[0].content.parts[0].text);
  } catch (err) {
    console.error('Could not parse Gemini response: ' + err);
    return null;
  }
}

// ---------------------------------------------------------------- plumbing

function questionSheet_() {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SHEET_ID')
  );
  return ss.getSheetByName(CONFIG.sheetName);
}

function isModerator_() {
  const email = Session.getActiveUser().getEmail();
  if (!email) return false;
  const list = (PropertiesService.getScriptProperties().getProperty('MODERATORS') || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); });
  return list.indexOf(email.toLowerCase()) !== -1;
}

function include(file) {
  return HtmlService.createHtmlOutputFromFile(file).getContent();
}

/** Run once from the editor. */
function setUp() {
  const props = PropertiesService.getScriptProperties();

  let sheetId = props.getProperty('SHEET_ID');
  let ss;
  if (sheetId) {
    ss = SpreadsheetApp.openById(sheetId);
  } else {
    ss = SpreadsheetApp.create('Question Desk — submissions');
    props.setProperty('SHEET_ID', ss.getId());
  }

  let sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.sheetName);
    sheet.appendRow(['ID', 'Submitted', 'Device', 'Question', 'Status', 'Topic',
                     'Language', 'Translation']);
    sheet.setFrozenRows(1);
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'clusterQuestions') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('clusterQuestions').timeBased().everyMinutes(1).create();

  props.setProperty('BOARD_OPEN', 'true');
  getEntryToken();

  console.log('Sheet: ' + ss.getUrl());
  console.log('Now set GEMINI_API_KEY and MODERATORS in Project Settings > Script Properties.');
}
