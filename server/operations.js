/**
 * Question Desk server code: retention, the weekly report, archiving, the health check, the load test and the every-minute schedule.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- operations

const REMOVED_TEXT = function (months) { return '[wording removed after ' + months + ' months]'; };

/** { retentionMonths: 0 (keep) | 3 | 6 | 12 | 24, weeklyReport: true } */
function opsSettings_() {
  const saved = JSON.parse(props_().getProperty('OPS') || '{}');
  return {
    retentionMonths: [0, 3, 6, 12, 24].indexOf(saved.retentionMonths) !== -1 ? saved.retentionMonths : 0,
    weeklyReport: saved.weeklyReport !== false
  };
}

function saveOpsSettings(input) {
  requireAdmin_();
  input = input || {};
  const months = Number(input.retentionMonths);
  if ([0, 3, 6, 12, 24].indexOf(months) === -1) throw new Error('Choose to keep question wording, or remove it after 3, 6, 12 or 24 months.');
  const next = { retentionMonths: months, weeklyReport: input.weeklyReport !== false };
  props_().setProperty('OPS', JSON.stringify(next));
  props_().deleteProperty('MAINT_AT');   // apply on the next scheduled run, not up to an hour later
  audit_('Operations settings changed', null,
    (months ? 'question wording removed ' + months + ' months after a session ends' : 'question wording kept') +
    ', weekly report ' + (next.weeklyReport ? 'on' : 'off'));
  return adminState();
}

/** Hourly housekeeping from the schedule: retention and the weekly report. */
function runMaintenance_() {
  const last = Number(props_().getProperty('MAINT_AT') || 0);
  if (Date.now() - last < 55 * 60 * 1000) return;
  props_().setProperty('MAINT_AT', String(Date.now()));
  try { applyRetention_(); } catch (err) { console.error('Retention: ' + err); }
  try { if (weeklyReportDue_()) sendWeeklyReport_(); } catch (err) { console.error('Weekly report: ' + err); }
}

/**
 * Removes question wording (original, translation and merged question) from sessions that
 * ended more than retentionMonths ago. Topics, languages, statuses, times and counts stay,
 * so reports still add up. Activity log entries that quoted questions are cleared too.
 */
function applyRetention_() {
  const months = opsSettings_().retentionMonths;
  flushInbox_();
  if (!months || !props_().getProperty('SHEET_ID')) return { questions: 0 };
  const cutoff = Date.now() - months * 30.44 * 24 * 3600 * 1000;
  const marker = REMOVED_TEXT(months);
  const old = {};
  allSessions_().forEach(function (x) { if (x.status === 'ended' && x.ended && x.ended < cutoff) old[x.id] = true; });
  archivedSessions_().forEach(function (a) { if (a.ended && a.ended < cutoff) old[a.id] = true; });
  if (!Object.keys(old).length) return { questions: 0 };

  let questions = 0, merged = 0, log = 0;
  withLock_(function () {
    const qs = questionSheet_();
    const values = qs.getDataRange().getValues();
    const textRows = [], translationRows = [];
    for (let i = 1; i < values.length; i++) {
      if (!old[String(values[i][COLS.session - 1])]) continue;
      if (String(values[i][COLS.text - 1]).indexOf('[wording removed') === 0) continue;
      textRows.push(i + 1);
      if (values[i][COLS.translation - 1]) translationRows.push(i + 1);
      questions++;
    }
    setCells_(qs, COLS.text, textRows, marker);
    setCells_(qs, COLS.translation, translationRows, marker);
    setCells_(qs, COLS.translations, textRows, '');
    questionsChanged_();
    const ts = topicSheet_();
    const tv = ts.getDataRange().getValues();
    const mergedRows = [];
    for (let j = 1; j < tv.length; j++) {
      if (!old[String(tv[j][0])] || !tv[j][2] || String(tv[j][2]).indexOf('[wording removed') === 0) continue;
      mergedRows.push(j + 1);
      merged++;
    }
    setCells_(ts, 3, mergedRows, marker);
    setCells_(ts, 6, mergedRows, '{}');
    topicsChanged_();
  });
  flushAudit_();
  const audit = spreadsheet_().getSheetByName(CONFIG.auditSheetName);
  if (audit && audit.getLastRow() > 1) {
    const av = audit.getDataRange().getValues();
    const logRows = [];
    for (let k = 1; k < av.length; k++) {
      const at = new Date(av[k][0]).getTime();
      if (at >= cutoff || !/^(Marked answered|Dismissed|Reopened|Topic merged|Answer now)$/.test(String(av[k][2]))) continue;
      if (String(av[k][5]).indexOf('[wording removed') === 0) continue;
      logRows.push(k + 1);
      log++;
    }
    setCells_(audit, 6, logRows, marker);
  }
  Object.keys(old).forEach(invalidateTopics_);
  if (questions || merged || log) {
    const was = EXEC_.auditWho;
    EXEC_.auditWho = 'Retention (automatic)';
    audit_('Old question wording removed', null, questions + ' questions, ' + merged + ' merged questions and ' + log + ' log entries from sessions that ended over ' + months + ' months ago');
    EXEC_.auditWho = was;
  }
  return { questions: questions, merged: merged, log: log };
}

/** Mondays from 8 a.m. in the app's time zone, once a week. */
function weeklyReportDue_() {
  if (!opsSettings_().weeklyReport) return false;
  const local = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})/);
  const weekday = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();   // 1 = Monday
  if (weekday !== 1 || +m[4] < 8) return false;
  const week = m[1] + '-' + m[2] + '-' + m[3];
  if (props_().getProperty('WEEKLY_SENT') === week) return false;
  props_().setProperty('WEEKLY_SENT', week);
  return true;
}

/** How full Script Properties are (500KB for the whole app). */
function storageUse_() {
  const all = props_().getProperties();
  let bytes = 0;
  const utf8 = function (str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3;
    }
    return n;
  };
  Object.keys(all).forEach(function (k) { bytes += utf8(k) + utf8(String(all[k])); });
  return { bytes: bytes, limit: 500000, percent: Math.round(bytes / 5000) };
}

/** The weekly report's content, also shown by "Send the weekly report now". */
function weeklyReport_() {
  flushInbox_();
  const tz = Session.getScriptTimeZone();
  const fmt = function (ms) { return Utilities.formatDate(new Date(ms), tz, 'EEE MMM d, h:mm a'); };
  const now = Date.now();
  const week = 7 * 24 * 3600 * 1000;
  const h = health_();
  const trigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'clusterQuestions'; });
  const storage = storageUse_();
  const sessions = allSessions_().filter(function (x) { return !x.loadTest; });
  const label = function (x) { const e = eventName_(x); return (e ? e + ' — ' : '') + x.name; };
  const upcoming = sessions.filter(function (x) { return x.status !== 'ended' && x.scheduledStart && x.scheduledStart > now && x.scheduledStart < now + week; })
    .sort(function (a, b) { return a.scheduledStart - b.scheduledStart; });
  const active = sessions.filter(function (x) { return x.status === 'active'; });
  const ended = sessions.filter(function (x) { return x.status === 'ended' && x.ended && x.ended > now - week; });
  const owed = sessions.filter(function (x) { return x.summaryPending && !x.summarySent; });
  let asked = 0;
  questionValues_().slice(1).forEach(function (r) {
    const t = r[COLS.submitted - 1] ? new Date(r[COLS.submitted - 1]).getTime() : 0;
    if (t > now - week && r[COLS.status - 1] !== 'prepared') asked++;
  });
  const ops = opsSettings_();
  const checks = [
    { name: 'Question grouping', ok: !h.failures && trigger, detail: !trigger ? 'The every-minute trigger is missing — run setUp().' : h.failures ? h.failures + ' failed runs in a row: ' + (h.lastError || '') : 'Working' },
    { name: 'Gemini API key', ok: !!props_().getProperty('GEMINI_API_KEY'), detail: props_().getProperty('GEMINI_API_KEY') ? 'Set' : 'Missing' },
    { name: 'Email quota', ok: MailApp.getRemainingDailyQuota() >= 20, detail: MailApp.getRemainingDailyQuota() + ' left today' },
    { name: 'Settings storage', ok: storage.percent < 80, detail: storage.percent + '% of 500 KB used' + (storage.percent >= 80 ? ' — archive or delete old sessions' : '') }
  ];
  if (owed.length) checks.push({ name: 'Summaries not sent', ok: false, detail: owed.map(label).join(', ') });
  return {
    checks: checks,
    upcoming: upcoming.map(function (x) { return label(x) + ' — ' + fmt(x.scheduledStart); }),
    active: active.map(label),
    ended: ended.map(label),
    asked: asked,
    retention: ops.retentionMonths ? 'Question wording is removed ' + ops.retentionMonths + ' months after a session ends.' : 'Question wording is kept.'
  };
}

function sendWeeklyReport_(onlyTo) {
  const r = weeklyReport_();
  const to = onlyTo ? [onlyTo] : adminEmails_();
  if (!to.length || MailApp.getRemainingDailyQuota() < to.length) return 0;
  const list = function (title, items, empty) {
    return '<h2 style="font-size:15px;margin:20px 0 6px">' + esc_(title) + '</h2>' +
      (items.length ? '<ul style="margin:0;padding-left:20px">' + items.map(function (i) { return '<li>' + esc_(i) + '</li>'; }).join('') + '</ul>'
        : '<p style="color:#5c6874;margin:0">' + esc_(empty) + '</p>');
  };
  const problems = r.checks.filter(function (c) { return !c.ok; }).length;
  const html = '<p style="margin:0 0 12px">' + (problems ? '<strong>' + problems + ' thing' + (problems === 1 ? '' : 's') + ' need attention.</strong>' : 'Everything looks healthy.') + '</p>' +
    '<table style="border-collapse:collapse;width:100%">' + r.checks.map(function (c) {
      return '<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e6eb;font-weight:700;color:' + (c.ok ? '#2e7d5b' : '#a3321f') + '">' + (c.ok ? '✓' : '✗') + '</td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #e2e6eb">' + esc_(c.name) + '</td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #e2e6eb;color:#5c6874">' + esc_(c.detail) + '</td></tr>';
    }).join('') + '</table>' +
    list('Coming up in the next 7 days', r.upcoming, 'Nothing scheduled.') +
    list('Active now', r.active, 'No sessions are active.') +
    list('Ended in the last 7 days', r.ended, 'None.') +
    '<p style="margin:20px 0 0;color:#5c6874">' + r.asked + ' questions asked in the last 7 days. ' + esc_(r.retention) + '</p>' +
    '<p style="margin:8px 0 0;color:#5c6874;font-size:13px">Turn this report off on the Admin page → Health &amp; testing.</p>';
  const brand = brand_(null);
  to.forEach(function (address) {
    MailApp.sendEmail({ to: address, subject: 'Question Desk weekly report' + (problems ? ' — ' + problems + ' need attention' : ''),
      htmlBody: emailShell_(brand, 'Weekly report', html), name: brand.orgName || 'Question Desk' });
  });
  return to.length;
}

/** "Send the weekly report now", to the admin who pressed it. */
function sendWeeklyReportNow() {
  const me = requireAdmin_();
  sendWeeklyReport_(me);
  audit_('Weekly report sent', null, 'to ' + me);
  return true;
}

// ---------------------------------------------------------------- archive

/**
 * Ended sessions move out of Script Properties (500KB for the whole app) into the Archive
 * sheet after CONFIG.archiveAfterDays, or when an admin archives one. Their questions stay
 * in the Questions sheet. restoreSession() brings one back.
 */
function archiveSheet_() {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.archiveSheetName);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.archiveSheetName);
    sheet.appendRow(['Session', 'Name', 'Event', 'Ended', 'Archived', 'Session data', 'Me too votes']);
  }
  return sheet;
}

function archiveSession_(sid) {
  flushInbox_(sid);
  let archived = null;
  withLock_(function () {
    const session = getSession_(sid);
    archived = session;
    if (!session || session.status !== 'ended') throw new Error('Only ended sessions can be archived.');
    archiveSheet_().appendRow([
      sid, sheetSafe_(session.name), session.eventId || '', new Date(session.ended || Date.now()), new Date(),
      JSON.stringify(session), props_().getProperty('VOTES_' + sid) || '{}'
    ]);
    ['SESSION_', 'TOKEN_', 'VOTES_'].forEach(function (prefix) { props_().deleteProperty(prefix + sid); });
  });
  invalidateTopics_(sid);
  audit_('Session archived', archived, '');
}

function archiveSession(sid) {
  requireAdmin_();
  archiveSession_(sid);
  return adminState();
}

function restoreSession(sid) {
  requireAdmin_();
  withLock_(function () {
    const sheet = archiveSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i >= 1; i--) {
      if (String(values[i][0]) !== String(sid)) continue;
      if (getSession_(sid)) throw new Error('That session is already restored.');
      const session = JSON.parse(values[i][5]);
      if (session.eventId && !getEvent_(session.eventId)) delete session.eventId;   // its event was deleted
      saveSession_(session);
      if (values[i][6] && values[i][6] !== '{}') props_().setProperty('VOTES_' + sid, String(values[i][6]));
      sheet.deleteRow(i + 1);
      audit_('Session restored', session, '');
      return;
    }
    throw new Error('Archived session not found.');
  });
  return adminState();
}

function archivedSessions_() {
  if (!props_().getProperty('SHEET_ID')) return [];
  const sheet = spreadsheet_().getSheetByName(CONFIG.archiveSheetName);
  if (!sheet) return [];
  return sheet.getDataRange().getValues().slice(1).map(function (r) {
    return { id: String(r[0]), name: String(r[1]), eventId: String(r[2] || ''),
             ended: r[3] ? new Date(r[3]).getTime() : null, archived: r[4] ? new Date(r[4]).getTime() : null };
  }).reverse();
}

/** Called by the schedule: archives sessions ended long ago whose summary isn't still owed. */
function archiveOld_() {
  const cutoff = Date.now() - CONFIG.archiveAfterDays * 24 * 3600 * 1000;
  allSessions_().forEach(function (s) {
    if (s.status !== 'ended' || !s.ended || s.ended > cutoff || (s.summaryPending && !s.summarySent) || s.loadTest) return;
    try { archiveSession_(s.id); } catch (err) { console.error('Archive ' + s.id + ': ' + err); }
  });
}

// ---------------------------------------------------------------- health

function health_() {
  return JSON.parse(props_().getProperty('HEALTH') || '{}');
}

/**
 * Tracks grouping runs. After CONFIG.alertAfterFailures failures in a row,
 * admins get one email (repeated at most every alertRepeatHours), and another
 * when grouping recovers. This is the early warning for a retired model ID.
 */
function noteGroupingResult_(error) {
  const h = health_();
  const now = Date.now();
  if (error) {
    h.failures = (h.failures || 0) + 1;
    h.lastError = String(error).slice(0, 500);
    h.lastErrorAt = now;
    const due = !h.alertedAt || now - h.alertedAt > CONFIG.alertRepeatHours * 3600 * 1000;
    if (h.failures >= CONFIG.alertAfterFailures && due) {
      if (alertAdmins_('Question grouping is failing',
        '<p>Questions are arriving but have not been grouped or translated for ' + h.failures +
        ' runs in a row. QA Facilitators still see every question, ungrouped.</p>' +
        '<p><strong>Last error:</strong> ' + esc_(h.lastError) + '</p>' +
        '<p>Open the Admin page → Health and run a health check. A 404 usually means the Gemini model ' +
        'name (' + esc_(geminiSettings_().model) + ') was retired; a 400 or 403 usually means the API key.</p>')) {
        h.alertedAt = now;
      }
    }
  } else {
    if (h.alertedAt) {
      alertAdmins_('Question grouping recovered', '<p>Grouping and translation are working again.</p>');
      h.alertedAt = null;
    }
    h.failures = 0;
    h.lastOkAt = now;
  }
  props_().setProperty('HEALTH', JSON.stringify(h));
}

function alertAdmins_(subject, html) {
  try {
    const to = adminEmails_();
    if (!to.length || MailApp.getRemainingDailyQuota() < to.length) return false;
    const brand = brand_(null);
    MailApp.sendEmail({ to: to.join(','), subject: 'Question Desk: ' + subject,
      htmlBody: emailShell_(brand, esc_(subject), html), name: brand.orgName || 'Question Desk' });
    return true;
  } catch (err) {
    console.error('Alert email failed: ' + err);
    return false;
  }
}

function runHealthCheck() {
  requireAdmin_();
  const checks = [];
  const add = function (name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail }); };

  const key = props_().getProperty('GEMINI_API_KEY');
  add('Gemini API key', key, key ? 'Set' : 'Missing — add it under Admin → Health & testing → Gemini.');
  if (key) {
    const started = Date.now();
    const r = geminiRequest_('Health check. Set ok to true.', {
      type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok']
    }, { task: 'grouping' });
    add('Gemini model ' + geminiSettings_().model, r.ok, r.ok ? 'Responded in ' + (Date.now() - started) + ' ms' : r.error);
  }

  const trigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'clusterQuestions';
  });
  add('Grouping and schedule trigger', trigger, trigger ? 'Runs every minute' : 'Missing — run setUp() from the editor.');

  try {
    const ss = spreadsheet_();
    const ok = [CONFIG.sheetName, CONFIG.topicSheetName, CONFIG.assetSheetName]
      .every(function (n) { return !!ss.getSheetByName(n); });
    add('Submissions sheet', ok, ok ? 'Reachable' : 'Some sheets are missing — run setUp() from the editor.');
  } catch (err) {
    add('Submissions sheet', false, String(err));
  }

  const quota = MailApp.getRemainingDailyQuota();
  add('Email quota', quota >= 10, quota + ' emails left today');

  const url = baseUrl_();
  const dev = /\/dev$/.test(url);
  add('App address', url && !dev, dev ? 'Points at the /dev test address — set the app address on the Branding tab.' : url);

  const storage = storageUse_();
  add('Settings storage', storage.percent < 80, storage.percent + '% of 500 KB used' + (storage.percent >= 80 ? ' — archive or delete old sessions' : ''));

  const h = health_();
  add('Recent grouping', (h.failures || 0) < CONFIG.alertAfterFailures,
    h.failures ? h.failures + ' failed runs in a row. Last error: ' + h.lastError
      : h.lastOkAt ? 'Working' : 'Nothing grouped yet');

  return { checks: checks, ranAt: Date.now() };
}

// ---------------------------------------------------------------- load test

/**
 * Starts a throwaway session and switches on the POST endpoint for an hour,
 * so scripts/loadtest.js can submit through the same path phones use.
 */
function startLoadTest() {
  const me = requireAdmin_();
  if (!loadTest_()) {
    const session = {
      id: newId_(8), name: 'Load test ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d h:mm a'),
      heading: 'Load test', access: 'link', theme: 'dark', maxLength: CONFIG.defaultMaxLength,
      moderators: [], emailOnEnd: false, linkKey: newId_(16), status: 'active', open: true,
      created: Date.now(), started: Date.now(), createdBy: me, loadTest: true, brand: { orgName: '', accent: '' }
    };
    saveSession_(session);
    props_().setProperty('LOADTEST', JSON.stringify({
      key: newId_(32), sid: session.id, expires: Date.now() + CONFIG.loadTestMinutes * 60000
    }));
    audit_('Load test started', null, CONFIG.loadTestMinutes + ' minutes');
  }
  return adminState();
}

/** Switches the endpoint off and deletes the load-test session and its questions. */
function stopLoadTest() {
  requireAdmin_();
  const lt = JSON.parse(props_().getProperty('LOADTEST') || 'null');
  if (lt) {
    if (getSession_(lt.sid)) deleteSession_(lt.sid);
    props_().deleteProperty('LOADTEST');
    audit_('Load test finished', null, '');
  }
  return adminState();
}

function loadTest_() {
  const lt = JSON.parse(props_().getProperty('LOADTEST') || 'null');
  return lt && Date.now() < lt.expires ? lt : null;
}

function loadTestView_() {
  const lt = JSON.parse(props_().getProperty('LOADTEST') || 'null');
  if (!lt) return null;
  const url = participantBaseUrl_();
  return {
    sid: lt.sid,
    key: lt.key,
    url: url,
    expires: lt.expires,
    expired: Date.now() >= lt.expires,
    command: 'node scripts/loadtest.js --url "' + url + '" --key ' + lt.key + ' --count 40'
  };
}

function doPost(e) {
  let body = null;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, reason: 'badRequest' });
  }
  const lt = loadTest_();
  if (!lt || !body || typeof body.key !== 'string' || body.key !== lt.key) {
    return json_({ ok: false, reason: 'disabled' });
  }
  const session = getSession_(lt.sid);
  if (!session) return json_({ ok: false, reason: 'disabled' });

  // After a round, the script asks how many questions really arrived: a reply can be lost
  // on Google's redirect even when the question was saved.
  if (body.action === 'count') {
    flushInbox_(lt.sid);
    return json_({ ok: true, saved: sessionRows_(lt.sid).length });
  }

  const started = Date.now();
  const res = submitQuestion_(lt.sid, Utilities.getUuid(), String(body.text || 'Load test question'),
                              session.linkKey, true);
  res.serverMs = Date.now() - started;
  return json_(res);
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- schedule

/** Starts and ends scheduled sessions. Called every minute by the trigger. */
function runSchedule_() {
  EXEC_.auditWho = 'Schedule (automatic)';
  const now = Date.now();
  let changed = 0;
  allSessions_().forEach(function (s) {
    if (s.status === 'ended') return;
    try {
      if (s.scheduledEnd && now >= s.scheduledEnd) {
        endSession_(s.id);
        changed++;
      } else if (s.scheduledStart && now >= s.scheduledStart && !s.scheduleStarted) {
        // Starts once. If an admin deactivates it afterwards, the schedule leaves it alone.
        const started = updateSession_(s.id, function (x) {
          x.scheduleStarted = true;
          x.status = 'active';
          if (!x.started) x.started = now;
        });
        audit_('Session started', started, 'by its schedule');
        changed++;
      }
    } catch (err) {
      console.error('Schedule for ' + s.id + ': ' + err);
    }
  });
  try { retrySummaries_(); } catch (err) { console.error('Summary retry: ' + err); }
  try { archiveOld_(); } catch (err) { console.error('Archive: ' + err); }
  try { trimAudit_(); } catch (err) { console.error('Activity log trim: ' + err); }
  try { runMaintenance_(); } catch (err) { console.error('Maintenance: ' + err); }
  try { translatePendingPrepared_(); } catch (err) { console.error('Prepared translation: ' + err); }
  delete EXEC_.auditWho;
  return changed;
}
