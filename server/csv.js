/**
 * Question Desk server code: sessions CSV export and import.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- CSV export and import

/**
 * Sessions as a CSV an admin can edit in a spreadsheet and import again. Import matches an
 * existing session by name plus scheduled start and end, or by name alone when neither time
 * is set. Columns missing from an imported file leave those settings unchanged on updates.
 */
const SESSION_CSV = [
  ['Event', 'event'],
  ['Session', 'name'],
  ['Room', 'room'],
  ['Heading participants see', 'heading'],
  ['How people join (room or link)', 'access'],
  ['Room screen theme (dark, light or contrast)', 'theme'],
  ['Seconds between questions', 'cooldownSeconds'],
  ['Longest question (characters)', 'maxLength'],
  ['Email summary when ended (yes or no)', 'emailOnEnd'],
  ['Scheduled start', 'scheduledStart'],
  ['Scheduled end', 'scheduledEnd'],
  ['QA Facilitators', 'moderators'],
  ['Guest page for room screen (yes or no)', 'guestRoom'],
  ['Guest page for PowerPoint slide (yes or no)', 'guestSlide'],
  ['Guest page for panelist view (yes or no)', 'guestPanel'],
  ['Guest page address', 'guestUrl'],
  ['Session organization name', 'brandOrgName'],
  ['Session accent color', 'brandAccent'],
  ['Prepared questions (one per line)', 'prepared'],
  ['Translate prepared questions when saved (yes or no)', 'translatePrepared'],
  ['Room screen lists questions (yes or no)', 'roomQuestions'],
  ['Status (not imported)', 'status']
];

const CSV_TIME_FORMAT = 'yyyy-MM-dd HH:mm';

function exportSessionsCsv() {
  requireAdmin_();
  const tz = Session.getScriptTimeZone();
  const prepared = {};
  questionValues_().slice(1).forEach(function (r) {
    if (r[COLS.status - 1] === 'prepared') (prepared[String(r[COLS.session - 1])] = prepared[String(r[COLS.session - 1])] || []).push(String(r[COLS.text - 1]));
  });
  const yesNo = function (v) { return v ? 'yes' : 'no'; };
  const time = function (ms) { return ms ? Utilities.formatDate(new Date(ms), tz, CSV_TIME_FORMAT) : ''; };
  const rows = allSessions_().filter(function (s) { return !s.loadTest; }).map(function (s) {
    const guest = guestChoice_(s.guestPage);
    const own = s.brand || {};
    const values = {
      event: eventName_(s), name: s.name, room: s.room || '', heading: s.heading, access: s.access, theme: s.theme || 'dark', roomQuestions: yesNo(s.roomQuestions),
      cooldownSeconds: cooldownFor_(s), maxLength: s.maxLength || CONFIG.defaultMaxLength, emailOnEnd: yesNo(s.emailOnEnd),
      scheduledStart: time(s.scheduledStart), scheduledEnd: time(s.scheduledEnd),
      moderators: (s.moderators || []).join('; '),
      guestRoom: yesNo(guest.room), guestSlide: yesNo(guest.slide), guestPanel: yesNo(guest.panel), guestUrl: guest.url,
      brandOrgName: own.orgName || '', brandAccent: own.accent || '',
      prepared: (prepared[s.id] || []).join('\n'), translatePrepared: yesNo(s.translatePrepared !== false), status: s.status
    };
    return SESSION_CSV.map(function (c) { return values[c[1]]; });
  });
  const header = SESSION_CSV.map(function (c) {
    return c[1] === 'scheduledStart' || c[1] === 'scheduledEnd' ? c[0] + ' (' + tz + ')' : c[0];
  });
  const csv = [header].concat(rows).map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
  audit_('Sessions exported', null, rows.length + ' sessions');
  return { filename: 'question-desk-sessions-' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') + '.csv', csv: '\ufeff' + csv, count: rows.length };
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
function parseCsv_(text) {
  text = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
}

/** "2026-10-03 18:30", "2026-10-03T18:30" or "10/3/2026 6:30 PM" in the app's time zone. */
function csvTime_(value, label) {
  const v = String(value || '').trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/);
  let y, mo, d, h, mi;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; h = +m[4]; mi = +m[5]; }
  else {
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
    if (!m) throw new Error(t_('err.csvNotADateTime', { label: label, value: v }));
    mo = +m[1]; d = +m[2]; y = +m[3]; h = +m[4]; mi = +m[5];
    if (m[6]) {
      if (h < 1 || h > 12) throw new Error(t_('err.csvBadHour', { label: label, value: v }));
      h = (h % 12) + (/p/i.test(m[6]) ? 12 : 0);
    }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error(t_('err.csvNotRealDate', { label: label, value: v }));
  const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  return Utilities.parseDate(y + '-' + p2(mo) + '-' + p2(d) + ' ' + p2(h) + ':' + p2(mi), Session.getScriptTimeZone(), CSV_TIME_FORMAT).getTime();
}

function csvYes_(value, label, fallback) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return fallback;
  if (/^(yes|y|true|1|x)$/.test(v)) return true;
  if (/^(no|n|false|0)$/.test(v)) return false;
  throw new Error(t_('err.csvYesNo', { label: label, value: value }));
}

/** The duplicate key: name, plus start and end when either is set. */
function sessionKey_(name, start, end) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // To the minute: that's what the CSV and the session form hold.
  const minute = function (ms) { return ms ? Math.floor(ms / 60000) : ''; };
  return start || end ? n + '|' + minute(start) + '|' + minute(end) : n;
}

/**
 * Checks (dryRun) or imports sessions from CSV text.
 * options: { duplicates: 'update' | 'skip' }
 * Returns { rows: [{ row, event, name, action, errors, warnings }], created, updated, skipped, failed, events }.
 */
function importSessionsCsv(text, options, dryRun) {
  const me = requireAdmin_();
  options = options || {};
  const onDuplicate = options.duplicates === 'skip' ? 'skip' : 'update';
  if (String(text || '').length > 2000000) throw new Error(t_('err.thatFileIsTooLarge'));
  const table = parseCsv_(text);
  if (!table.length) throw new Error(t_('err.theFileIsEmpty'));
  if (table.length - 1 > CONFIG.maxImportRows) throw new Error(t_('err.csvTooManyRows', { max: CONFIG.maxImportRows }));

  // Columns by header name, forgiving case, spacing and the time zone suffix.
  const norm = function (h) { return String(h || '').replace(/\(.*?\)/g, '').replace(/[^a-z]/gi, '').toLowerCase(); };
  const known = {};
  SESSION_CSV.forEach(function (c) { known[norm(c[0])] = c[1]; });
  const columns = table[0].map(function (h) { return known[norm(h)] || null; });
  if (columns.indexOf('name') === -1) throw new Error(t_('err.theFileNeedsASession'));

  const roster = roster_('MODERATORS');
  const existing = {};
  allSessions_().forEach(function (s) { existing[sessionKey_(s.name, s.scheduledStart, s.scheduledEnd)] = s; });
  const eventsByName = {};
  allEvents_().forEach(function (e) { eventsByName[e.name.trim().toLowerCase()] = e; });
  const seenInFile = {};
  const newEvents = {};
  const result = { rows: [], created: 0, updated: 0, skipped: 0, failed: 0, events: [] };
  const createdIds = [];
  const unquote = function (v) { return /^'[=+\-@]/.test(v) ? v.slice(1) : v; };   // undo csvCell_'s guard
  if (!dryRun) EXEC_.auditVia = 'CSV import';

  table.slice(1).forEach(function (cells, i) {
    const rowNumber = i + 2;
    const get = {};
    columns.forEach(function (key, c) { if (key) get[key] = unquote(String(cells[c] === undefined ? '' : cells[c])); });
    const has = function (key) { return Object.prototype.hasOwnProperty.call(get, key); };
    const out = { row: rowNumber, event: (get.event || '').trim(), name: (get.name || '').trim(), action: '', errors: [], warnings: [] };
    result.rows.push(out);
    try {
      if (!out.name) throw new Error(t_('err.noSessionName'));
      const start = has('scheduledStart') ? csvTime_(get.scheduledStart, t_('csv.label.scheduledStart')) : undefined;
      const end = has('scheduledEnd') ? csvTime_(get.scheduledEnd, t_('csv.label.scheduledEnd')) : undefined;
      const key = sessionKey_(out.name, start, end);
      if (seenInFile[key]) throw new Error(t_('err.csvDuplicateRow', { row: seenInFile[key] }));
      seenInFile[key] = rowNumber;

      const match = existing[sessionKey_(out.name, start === undefined ? null : start, end === undefined ? null : end)];
      if (match && onDuplicate === 'skip') { out.action = 'skip'; out.warnings.push(t_('csv.alreadyExists')); result.skipped++; return; }
      if (match && match.status === 'ended') { out.action = 'skip'; out.warnings.push(t_('csv.alreadyEnded')); result.skipped++; return; }

      // Start from the existing session's settings, so missing columns change nothing.
      const input = match ? sessionInput_(match) : { name: out.name, emailOnEnd: true };
      input.name = out.name;
      if (has('room')) input.room = get.room;
      if (has('heading')) input.heading = get.heading;
      if (has('access')) {
        const a = get.access.trim().toLowerCase();
        if (a && a !== 'room' && a !== 'link') throw new Error(t_('err.csvAccess', { value: get.access }));
        if (a) input.access = a;
      }
      if (has('theme')) {
        const t = get.theme.trim().toLowerCase();
        if (t && t !== 'dark' && t !== 'light' && t !== 'contrast') throw new Error(t_('err.csvTheme', { value: get.theme }));
        if (t) input.theme = t;
      }
      if (has('cooldownSeconds') && get.cooldownSeconds.trim() !== '') input.cooldownSeconds = get.cooldownSeconds.trim();
      if (has('maxLength') && get.maxLength.trim() !== '') input.maxLength = get.maxLength.trim();
      if (has('emailOnEnd')) input.emailOnEnd = csvYes_(get.emailOnEnd, t_('csv.label.emailOnEnd'), input.emailOnEnd);
      if (start !== undefined) input.scheduledStart = start;
      if (end !== undefined) input.scheduledEnd = end;
      if (has('moderators')) {
        const listed = parseEmails_(get.moderators);
        const missing = listed.filter(function (e) { return roster.indexOf(e) === -1; });
        if (missing.length) out.warnings.push(t_('csv.notOnFacilitatorList', { names: missing.join(', ') }));
        input.moderators = listed.filter(function (e) { return roster.indexOf(e) !== -1; });
      }
      if (has('guestRoom') || has('guestSlide') || has('guestPanel') || has('guestUrl')) {
        const g = guestChoice_(input.guestPage);
        input.guestPage = {
          room: csvYes_(get.guestRoom, t_('csv.label.guestRoom'), g.room),
          slide: csvYes_(get.guestSlide, t_('csv.label.guestSlide'), g.slide),
          panel: csvYes_(get.guestPanel, t_('csv.label.guestPanel'), g.panel),
          url: has('guestUrl') ? get.guestUrl.trim() : g.url
        };
      }
      if (has('roomQuestions')) input.roomQuestions = csvYes_(get.roomQuestions, t_('csv.label.roomQuestions'), !!input.roomQuestions);
      if (has('translatePrepared')) input.translatePrepared = csvYes_(get.translatePrepared, t_('csv.label.translatePrepared'), input.translatePrepared !== false);
      if (has('brandOrgName')) input.brandOrgName = get.brandOrgName;
      if (has('brandAccent')) input.brandAccent = get.brandAccent.trim().toLowerCase();
      if (has('prepared')) {
        const lines = get.prepared.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
        const current = match ? sessionRows_(match.id, true).filter(function (q) { return q.status === 'prepared'; }).map(function (q) { return q.text; }) : [];
        if (lines.join('\n') !== current.join('\n')) input.prepared = lines;   // unchanged lists keep their ids
      }
      if (has('event')) {
        const evName = out.event;
        if (!evName) input.eventId = '';
        else if (eventsByName[evName.toLowerCase()]) input.eventId = eventsByName[evName.toLowerCase()].id;
        else {
          if (!newEvents[evName.toLowerCase()]) { newEvents[evName.toLowerCase()] = evName; result.events.push(evName); }
          input.eventId = '';   // created below, when importing for real
          out.warnings.push(t_('csv.newEvent', { name: evName }));
        }
      }

      out.action = match ? 'update' : 'create';
      if (match) input.id = match.id;
      if (dryRun) {
        const eventForCheck = input.eventId;
        saveSessionAs_(input, me, true);
        input.eventId = eventForCheck;
      } else {
        if (has('event') && out.event && !eventsByName[out.event.toLowerCase()]) {
          const ev = createEvent_(out.event, me);
          eventsByName[out.event.toLowerCase()] = ev;
        }
        if (has('event') && out.event) input.eventId = eventsByName[out.event.toLowerCase()].id;
        const id = saveSessionAs_(input, me, false);
        existing[sessionKey_(input.name, input.scheduledStart, input.scheduledEnd)] = getSession_(id);
        if (!match) createdIds.push(id);
      }
      if (match) result.updated++; else result.created++;
    } catch (err) {
      out.action = 'error';
      out.errors.push(String(err && err.message || err));
      result.failed++;
    }
  });
  if (!dryRun) {
    delete EXEC_.auditVia;
    audit_('Sessions imported', null, result.created + ' created, ' + result.updated + ' updated, ' + result.skipped + ' skipped, ' + result.failed + ' with problems');
    // New sessions go on top one by one, which would reverse the file: keep the file's order.
    if (createdIds.length > 1) reorderSessions_(createdIds.concat(allSessions_().map(function (x) { return x.id; }).filter(function (id) { return createdIds.indexOf(id) === -1; })));
    result.state = adminState();
  }
  return result;
}

/** The form input that would save this session as it is. */
function sessionInput_(s) {
  const own = s.brand || {};
  return {
    id: s.id, name: s.name, room: s.room || '', heading: s.heading, access: s.access, theme: s.theme, maxLength: s.maxLength,
    cooldownSeconds: cooldownFor_(s), moderators: (s.moderators || []).slice(), emailOnEnd: !!s.emailOnEnd,
    translatePrepared: s.translatePrepared !== false, roomQuestions: !!s.roomQuestions,
    roomLanguage: s.roomLanguage || '',
    scheduledStart: s.scheduledStart || null, scheduledEnd: s.scheduledEnd || null,
    brandOrgName: own.orgName || '', brandAccent: own.accent || '', guestPage: s.guestPage, eventId: s.eventId || ''
  };
}

function createEvent_(name, me) {
  return withLock_(function () {
    const orders = allEvents_().map(function (e) { return typeof e.order === 'number' ? e.order : 0; });
    const ev = { id: newId_(8), name: cleanText_(name, 80), brand: {}, hasLogo: false, created: Date.now(), createdBy: me,
                 order: orders.length ? Math.min.apply(null, orders) - 1 : 0 };
    saveEvent_(ev);
    audit_('Event created', { id: ev.id, eventName: ev.name }, '');
    return ev;
  });
}
