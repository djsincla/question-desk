/**
 * Question Desk server code: shared helpers: locks, caches, the sheets, ids and text safety.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- plumbing

/*
 * Per-execution cache. Apps Script starts every request with fresh globals, so this
 * only avoids repeating work inside one request: opening the spreadsheet costs
 * hundreds of milliseconds, and a button click used to open it and read the whole
 * question sheet several times. Anything that writes must call the matching *Changed_().
 */
let EXEC_ = {};

function resetExecution_() {
  EXEC_ = {};
}

function spreadsheet_() {
  const id = props_().getProperty('SHEET_ID');
  if (!EXEC_.ss || EXEC_.ssId !== id) {
    EXEC_.ss = SpreadsheetApp.openById(id);
    EXEC_.ssId = id;
  }
  return EXEC_.ss;
}

function questionValues_() {
  if (!EXEC_.questions) EXEC_.questions = questionSheet_().getDataRange().getValues();
  return EXEC_.questions;
}

function topicValues_() {
  if (!EXEC_.topics) {
    const sheet = topicSheet_();
    EXEC_.topics = sheet ? sheet.getDataRange().getValues() : [[]];
  }
  return EXEC_.topics;
}

function questionsChanged_() { delete EXEC_.questions; }
function topicsChanged_() { delete EXEC_.topics; }

function questionSheet_() {
  return spreadsheet_().getSheetByName(CONFIG.sheetName);
}

function topicSheet_() {
  return spreadsheet_().getSheetByName(CONFIG.topicSheetName);
}

function assetSheet_() {
  return props_().getProperty('SHEET_ID') ? spreadsheet_().getSheetByName(CONFIG.assetSheetName) : null;
}

/**
 * Questions for one session. Prepared questions (loaded by an admin, not yet added
 * to the queue by a QA Facilitator) are left out unless includePrepared is true:
 * until used they are not questions anyone asked.
 */
function sessionRows_(sid, includePrepared) {
  return questionValues_().slice(1)
    .filter(function (r) {
      return String(r[COLS.session - 1]) === sid && (includePrepared || r[COLS.status - 1] !== 'prepared');
    })
    .map(function (r) {
      return {
        id: String(r[COLS.id - 1]),
        text: String(r[COLS.text - 1]),
        lang: r[COLS.lang - 1] && r[COLS.lang - 1] !== '?' ? r[COLS.lang - 1] : '',   // "?" only marks "leave ungrouped"
        translation: r[COLS.translation - 1] ? String(r[COLS.translation - 1]) : '',
        topic: r[COLS.topic - 1] ? String(r[COLS.topic - 1]) : '',
        translations: parseJson_(r[COLS.translations - 1]),
        // About running the event, and whether a coordinator has dealt with it.
        logistics: !!r[COLS.logistics - 1],
        sorted: String(r[COLS.logistics - 1] || '') === 'sorted',
        status: r[COLS.status - 1],
        submitted: r[COLS.submitted - 1] ? new Date(r[COLS.submitted - 1]).getTime() : 0
      };
    });
}

/** { topic: { merged, labels, mergedLabels } } for one session, from the Topics sheet. */
function topicRecords_(sid) {
  const out = {};
  topicValues_().slice(1).forEach(function (r) {
    if (String(r[0]) !== sid) return;
    out[String(r[1])] = {
      merged: r[2] ? String(r[2]) : '',
      labels: parseJson_(r[4]),
      mergedLabels: parseJson_(r[5]),
      shown: String(r[6]) === 'yes'
    };
  });
  return out;
}

/**
 * Writes topic records. With onlyMissingLabels, existing label translations are
 * kept so a topic's wording on phones doesn't change between runs.
 */
function upsertTopics_(sid, updates, onlyMissingLabels) {
  const sheet = topicSheet_();
  const topics = Object.keys(updates);
  if (!sheet || !topics.length) return;
  withLock_(function () {
    const values = sheet.getDataRange().getValues();
    const rowOf = {};
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === sid) rowOf[String(values[i][1])] = i + 1;
    }
    topics.forEach(function (topic) {
      const u = updates[topic];
      const row = rowOf[topic];
      if (!row) {
        sheet.appendRow([sid, sheetSafe_(topic), u.merged ? sheetSafe_(u.merged) : '', new Date(),
          JSON.stringify(u.labels || {}), JSON.stringify(u.mergedLabels || {}), u.shown ? 'yes' : '']);
        return;
      }
      if (u.shown !== undefined) sheet.getRange(row, 7).setValue(u.shown ? 'yes' : '');
      if (u.labels) {
        const current = parseJson_(values[row - 1][4]);
        // Existing wording stays put so phones don't flicker between runs; languages the
        // label doesn't have yet (say, an event added Vietnamese) are filled in.
        const next = onlyMissingLabels ? Object.assign({}, u.labels, current) : u.labels;
        if (JSON.stringify(next) !== JSON.stringify(current)) sheet.getRange(row, 5).setValue(JSON.stringify(next));
      }
      if (u.merged !== undefined) {
        sheet.getRange(row, 3, 1, 2).setValues([[sheetSafe_(u.merged), new Date()]]);
        sheet.getRange(row, 6).setValue(JSON.stringify(u.mergedLabels || {}));
      }
    });
    topicsChanged_();
  });
}

function parseJson_(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

/** Anonymous text must never be evaluated as a spreadsheet formula. */
const INBOX_PREFIX = 'Q_';   // Q_<session>_<question id>: a submitted question not yet in the sheet

/**
 * Moves buffered submissions (one Script Properties key each) into the Questions sheet in a
 * single write, oldest first. sid limits it to one session. Safe to repeat: rows already in
 * the sheet (a flush interrupted before clearing its keys) aren't written twice. Returns how
 * many rows were written.
 */
function flushInbox_(sid) {
  const prefix = INBOX_PREFIX + (sid ? sid + '_' : '');
  const has = function (all) { return Object.keys(all).filter(function (k) { return k.indexOf(prefix) === 0; }); };
  if (!has(props_().getProperties()).length) return 0;
  let written = 0;
  const touched = {};
  withLock_(function () {
    const all = props_().getProperties();   // again, inside the lock: another run may have flushed
    const keys = has(all);
    if (!keys.length) return;
    const sheet = questionSheet_();
    const last = sheet.getLastRow();
    const inSheet = {};
    if (last > 1) sheet.getRange(2, COLS.id, last - 1, 1).getValues().forEach(function (r) { inSheet[String(r[0])] = true; });
    const rows = keys.map(function (k) { try { return JSON.parse(all[k]); } catch (e) { return null; } })
      .filter(function (r) { return r && !inSheet[String(r[0])]; })
      .sort(function (a, b) { return a[1] - b[1]; })
      .map(function (r) {
        touched[r[4]] = true;
        return [r[0], new Date(r[1]), r[2], sheetSafe_(r[3]), 'new', '', '', '', r[4]];
      });
    if (rows.length) {
      const need = last + rows.length;
      if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows() + 200);
      sheet.getRange(last + 1, 1, rows.length, 9).setValues(rows);
      SpreadsheetApp.flush();
    }
    keys.forEach(function (k) { props_().deleteProperty(k); });
    written = rows.length;
    questionsChanged_();
  });
  Object.keys(touched).forEach(invalidateTopics_);
  return written;
}

/** Questions still in the inbox for a session (not yet in the sheet). */
/**
 * Writes one value into the same column of many rows in a single call (a RangeList), instead
 * of one call per cell — "Dismiss all" on 20 questions was 20 round trips to Sheets.
 */
/**
 * Changes some of one session's question rows: under the lock, re-reads the sheet (rows can
 * move while waiting for it), picks the rows whose ID is in `ids` and that `match(row)`
 * accepts (a row of sheet values; COLS gives the positions), and writes each value in `set`
 * ({ status: 'answered', topic: '' … }) to all of them, one call per column. Returns the
 * picked rows as they were before the change. Every staff action on questions goes through
 * here, so none can write a row without the lock.
 */
function changeQuestions_(sid, ids, match, set) {
  const wanted = {};
  (ids || []).forEach(function (id) { wanted[String(id)] = true; });
  const picked = [];
  withLock_(function () {
    const sheet = questionSheet_();
    const values = sheet.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][COLS.session - 1]) !== sid || !wanted[String(values[i][COLS.id - 1])]) continue;
      if (match && !match(values[i])) continue;
      rows.push(i + 1);
      picked.push(values[i]);
    }
    Object.keys(set).forEach(function (name) { setCells_(sheet, COLS[name], rows, set[name]); });
    questionsChanged_();
  });
  return picked;
}

function setCells_(sheet, col, rows, value) {
  if (!rows.length) return;
  const letter = String.fromCharCode(64 + col);   // columns A–Z are all we use
  sheet.getRangeList(rows.map(function (r) { return letter + r; })).setValue(value);
}

function sheetSafe_(value) {
  const s = String(value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function csvCell_(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function esc_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cleanText_(value, max) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function domainOf_(email) {
  return String(email || '').split('@')[1] || '';
}

function parseEmails_(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const seen = {};
  const out = [];
  list.forEach(function (raw) {
    const e = String(raw || '').trim().toLowerCase();
    if (!e) return;
    if (!EMAIL_RE.test(e)) throw new Error(t_('err.notAnEmail', { value: e }));
    if (!seen[e]) { seen[e] = true; out.push(e); }
  });
  if (out.length > CONFIG.maxRecipients) throw new Error(t_('err.tooManyRecipients', { max: CONFIG.maxRecipients }));
  return out;
}

/**
 * Run from the editor once, and again after updates that add permissions.
 * Safe to re-run: creates what is missing and migrates single-session data.
 * Admin only, since google.script.run can reach any public function.
 */
function setUp() {
  if (!isAdmin_()) throw new Error(t_('err.runSetupFromTheApps'));
  const props = props_();

  let ss;
  if (props.getProperty('SHEET_ID')) {
    ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  } else {
    ss = SpreadsheetApp.create('Question Desk — submissions');
    props.setProperty('SHEET_ID', ss.getId());
  }

  let sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.sheetName);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  } else {
    if (!sheet.getRange(1, COLS.session).getValue()) sheet.getRange(1, COLS.session).setValue('Session');
    if (!sheet.getRange(1, COLS.grouping).getValue()) sheet.getRange(1, COLS.grouping).setValue('Grouping');
    if (!sheet.getRange(1, COLS.translations).getValue()) sheet.getRange(1, COLS.translations).setValue('Translations');
    if (!sheet.getRange(1, COLS.logistics).getValue()) sheet.getRange(1, COLS.logistics).setValue('Logistics');
  }

  let topicSheet = ss.getSheetByName(CONFIG.topicSheetName);
  if (!topicSheet) {
    topicSheet = ss.insertSheet(CONFIG.topicSheetName);
    topicSheet.appendRow(TOPIC_HEADERS);
    topicSheet.setFrozenRows(1);
  } else {
    topicSheet.getRange(1, 1, 1, TOPIC_HEADERS.length).setValues([TOPIC_HEADERS]);
  }

  if (!ss.getSheetByName(CONFIG.auditSheetName)) {
    ss.insertSheet(CONFIG.auditSheetName).appendRow(['Time', 'Who', 'Action', 'Session or event ID', 'Session or event', 'Details']);
  }
  if (!ss.getSheetByName(CONFIG.archiveSheetName)) {
    ss.insertSheet(CONFIG.archiveSheetName).appendRow(['Session', 'Name', 'Event', 'Ended', 'Archived', 'Session data', 'Me too votes']);
  }
  if (!ss.getSheetByName(CONFIG.assetSheetName)) {
    ss.insertSheet(CONFIG.assetSheetName).appendRow(['Key', 'Data (continues across columns)']);
  }

  // Plain text, so an ID like 12e45678 or a question like "3/4" isn't turned into a number or date.
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('C:I').setNumberFormat('@');
  topicSheet.getRange('A:C').setNumberFormat('@');
  topicSheet.getRange('G:G').setNumberFormat('@');

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'clusterQuestions') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('clusterQuestions').timeBased().everyMinutes(1).create();

  // Migrate a single-session install: untagged questions become the first session.
  const last = sheet.getLastRow();
  const untagged = last > 1 && sheet.getRange(2, COLS.session, last - 1, 1).getValues()
    .some(function (r) { return !r[0]; });
  if (!allSessions_().length && (untagged || props.getProperty('TOKEN_CURRENT'))) {
    const first = {
      id: newId_(8), name: 'First session', heading: props.getProperty('SESSION_HEADING') || 'Questions for the panel',
      access: 'room', theme: 'dark', maxLength: CONFIG.defaultMaxLength,
      moderators: roster_('MODERATORS'), emailOnEnd: false, linkKey: newId_(16),
      status: 'active', open: props.getProperty('BOARD_OPEN') !== 'false',
      created: Date.now(), started: Date.now(), createdBy: ownerEmail_(),
      brand: { orgName: '', accent: '' }
    };
    saveSession_(first);
    if (last > 1) {
      const range = sheet.getRange(2, COLS.session, last - 1, 1);
      range.setValues(range.getValues().map(function (r) { return [r[0] || first.id]; }));
    }
    const oldMerged = JSON.parse(props.getProperty('MERGED') || '{}');
    Object.keys(oldMerged).forEach(function (topic) {
      topicSheet.appendRow([first.id, sheetSafe_(topic), sheetSafe_(oldMerged[topic]), new Date(), '{}', '{}', '']);
    });
    console.log('Migrated existing questions into "First session" (' + first.id + ').');
  }
  ['TOKEN_CURRENT', 'TOKEN_PREVIOUS', 'TOKEN_ISSUED', 'BOARD_OPEN', 'MERGED', 'SESSION_HEADING']
    .forEach(function (k) { props.deleteProperty(k); });

  // Touch MailApp so the editor asks for the send-email permission now, not mid-event.
  console.log('Email quota remaining today: ' + MailApp.getRemainingDailyQuota());
  console.log('Sheet: ' + ss.getUrl());
  console.log('Admin page: <deployment URL>?view=admin (signed in as ' + ownerEmail_() + ')');
}
