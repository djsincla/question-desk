/**
 * Question Desk server code: the activity log of staff actions.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- activity log

/**
 * Who did what, when: every administrator and QA Facilitator change, and what the schedule
 * did on its own, appended to the "Activity log" sheet. Participants' questions are not
 * logged here (they are in the Questions sheet, anonymously). Never throws: a logging
 * failure must not undo or block the action it describes.
 */
function audit_(action, session, details) {
  try {
    const who = EXEC_.auditWho || currentEmail_() || 'unknown';
    const label = !session ? '' : session.eventName !== undefined ? session.eventName
      : (eventName_(session) ? eventName_(session) + ' — ' : '') + (session.name || '');
    const entry = [Date.now(), who, action, session && session.id ? session.id : '', String(label).slice(0, 200),
      String((details || '') + (EXEC_.auditVia ? ' (' + EXEC_.auditVia + ')' : '')).slice(0, 1000)];
    // Buffered (a few ms), and written to the sheet in batches by flushAudit_(), so logging
    // doesn't add a spreadsheet write to every queue click. Keys sort in the order logged.
    EXEC_.auditSeq = (EXEC_.auditSeq || 0) + 1;
    const key = AUDIT_PREFIX + String(entry[0]).padStart(15, '0') + '_' + String(EXEC_.auditSeq).padStart(4, '0') + '_' + newId_(4);
    try {
      props_().setProperty(key, JSON.stringify(entry));
    } catch (err) {
      writeAudit_([entry]);   // storage full or refusing: straight to the sheet
    }
  } catch (err) {
    console.error('Activity log: ' + err);
  }
}

const AUDIT_PREFIX = 'A_';   // A_<time>_<seq>_<rand>: an activity log entry not yet in the sheet

function writeAudit_(entries) {
  const sheet = auditSheet_();
  const rows = entries.map(function (e) {
    return [new Date(e[0]), sheetSafe_(e[1]), sheetSafe_(e[2]), e[3], sheetSafe_(e[4]), sheetSafe_(e[5])];
  });
  const last = sheet.getLastRow();
  if (sheet.getMaxRows() < last + rows.length) sheet.insertRowsAfter(sheet.getMaxRows(), last + rows.length - sheet.getMaxRows() + 200);
  sheet.getRange(last + 1, 1, rows.length, 6).setValues(rows);
}

/** Moves buffered activity log entries into the sheet in one write, in the order they happened. */
function flushAudit_() {
  // By time and sequence; the random tail isn't compared, so same-millisecond entries keep their stored order.
  const order = function (k) { return k.slice(0, AUDIT_PREFIX.length + 20); };
  const has = function (all) {
    return Object.keys(all).filter(function (k) { return k.indexOf(AUDIT_PREFIX) === 0; })
      .sort(function (a, b) { return order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0; });
  };
  if (!has(props_().getProperties()).length) return 0;
  let written = 0;
  withLock_(function () {
    const all = props_().getProperties();
    const keys = has(all);
    if (!keys.length) return;
    const entries = keys.map(function (k) { try { return JSON.parse(all[k]); } catch (e) { return null; } }).filter(Boolean);
    if (entries.length) writeAudit_(entries);
    keys.forEach(function (k) { props_().deleteProperty(k); });
    written = entries.length;
  });
  return written;
}

function auditSheet_() {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.auditSheetName);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.auditSheetName);
    sheet.appendRow(['Time', 'Who', 'Action', 'Session or event ID', 'Session or event', 'Details']);
  }
  return sheet;
}

/** Newest first. options: { query, target, limit } — query matches who, action, name or details. */
function getActivity(options) {
  requireAdmin_();
  options = options || {};
  try { flushAudit_(); } catch (err) { console.error('Activity log flush: ' + err); }
  if (!props_().getProperty('SHEET_ID')) return { entries: [], total: 0 };
  const sheet = spreadsheet_().getSheetByName(CONFIG.auditSheetName);
  if (!sheet || sheet.getLastRow() < 2) return { entries: [], total: 0 };
  const last = sheet.getLastRow();
  const scan = Math.min(last - 1, 3000);
  const values = sheet.getRange(last - scan + 1, 1, scan, 6).getValues();
  const q = String(options.query || '').trim().toLowerCase();
  const target = String(options.target || '');
  const limit = Math.min(Number(options.limit) || 200, 500);
  const entries = [];
  for (let i = values.length - 1; i >= 0 && entries.length < limit; i--) {
    const r = values[i];
    if (target && String(r[3]) !== target) continue;
    if (q && [r[1], r[2], r[4], r[5]].join(' ').toLowerCase().indexOf(q) === -1) continue;
    entries.push({ at: new Date(r[0]).getTime(), who: String(r[1]), action: String(r[2]), target: String(r[3]), label: String(r[4]), details: String(r[5]) });
  }
  return { entries: entries, total: last - 1, scanned: scan };
}

function trimAudit_() {
  if (!props_().getProperty('SHEET_ID')) return;
  flushAudit_();
  const sheet = spreadsheet_().getSheetByName(CONFIG.auditSheetName);
  if (!sheet) return;
  const extra = sheet.getLastRow() - 1 - CONFIG.auditMaxRows;
  if (extra > 0) sheet.deleteRows(2, extra + Math.floor(CONFIG.auditMaxRows / 10));   // trim in chunks, not every minute
}

/** A short "what changed" for a session edit. */
function sessionChanges_(before, after) {
  const labels = {
    name: 'name', heading: 'heading', access: 'how people join', theme: 'theme', maxLength: 'length limit',
    cooldownSeconds: 'wait between questions', moderators: 'QA Facilitators', emailOnEnd: 'summary email',
    summary: 'summary recipients', scheduledStart: 'scheduled start', scheduledEnd: 'scheduled end',
    brand: 'session branding', guestPage: 'guest page', eventId: 'event'
  };
  return Object.keys(labels).filter(function (k) {
    return JSON.stringify(before[k] === undefined ? null : before[k]) !== JSON.stringify(after[k] === undefined ? null : after[k]);
  }).map(function (k) {
    if (k === 'name') return 'renamed from "' + before.name + '"';
    if (k === 'eventId') return 'event: ' + (eventName_(after) || 'none');
    return labels[k];
  }).join(', ');
}
