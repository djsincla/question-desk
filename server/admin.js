/**
 * Question Desk server code: the Admin page: state, saving sessions, branding and summary recipients.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- admin

function adminState() {
  const me = requireAdmin_();
  flushInbox_();
  const counts = {};
  const prepared = {};
  const values = questionValues_();
  for (let i = 1; i < values.length; i++) {
    const sid = String(values[i][COLS.session - 1]);
    if (values[i][COLS.status - 1] === 'prepared') {
      (prepared[sid] = prepared[sid] || []).push(String(values[i][COLS.text - 1]));
    } else {
      counts[sid] = (counts[sid] || 0) + 1;
    }
  }

  return {
    me: me,
    owner: ownerEmail_(),
    domain: domainOf_(ownerEmail_()),
    admins: roster_('ADMINS'),
    moderators: roster_('MODERATORS'),
    coordinators: roster_('COORDINATORS'),
    sessions: allSessions_().map(function (s) {
      const out = JSON.parse(JSON.stringify(s));
      out.links = sessionLinks_(s);
      out.guestPage = guestChoice_(s.guestPage);
      out.questionCount = counts[s.id] || 0;
      out.prepared = prepared[s.id] || [];
      out.summaryTo = summaryRecipients_(s);
      return out;
    }),
    events: allEvents_(),
    languages: Object.keys(CONFIG.languages).map(function (code) { return { code: code, name: CONFIG.languages[code].name, native: CONFIG.languages[code].native }; }),
    siteLanguages: siteLanguages_(),
    maxLanguages: CONFIG.maxLanguages,
    archived: archivedSessions_(),
    brand: brand_(null),
    summaryDefaults: summaryDefaults_(),
    publicUrl: props_().getProperty('PUBLIC_URL') || '',
    guestPageUrl: props_().getProperty('GUEST_PAGE_URL') || '',
    guestPageDefault: DEFAULT_GUEST_PAGE,
    detectedUrl: baseUrlDetected_(),
    appUrl: baseUrl_(),
    ops: opsSettings_(),
    gemini: geminiSettings_(),
    geminiDefaults: geminiDefaults_(),
    prompts: promptSettings_(),
    storage: storageUse_(),
    geminiKeySet: !!props_().getProperty('GEMINI_API_KEY'),
    sheetUrl: spreadsheet_().getUrl(),
    mailQuota: MailApp.getRemainingDailyQuota(),
    health: health_(),
    loadTest: loadTestView_(),
    limits: {
      maxLengthCeiling: CONFIG.maxLengthCeiling, defaultMaxLength: CONFIG.defaultMaxLength,
      cooldownSeconds: CONFIG.cooldownSeconds, cooldownCeiling: CONFIG.cooldownCeiling
    },
    app: { version: APP.version, releaseNotes: APP.repo + '/releases/tag/v' + APP.version, repo: APP.repo }
  };
}

function saveSession(input) {
  const me = requireAdmin_();
  saveSessionAs_(input, me, false);
  return adminState();
}

/**
 * Validates and stores a session from form (or CSV import) input. With dryRun it only
 * validates, throwing the same errors a save would. Returns the session id.
 */
function saveSessionAs_(input, me, dryRun) {
  input = input || {};

  const name = cleanText_(input.name, 80);
  if (!name) throw new Error(t_('err.giveTheSessionAName'));
  const access = input.access === 'link' ? 'link' : 'room';
  const theme = input.theme === 'light' || input.theme === 'contrast' ? input.theme : 'dark';
  const maxLength = Math.round(Number(input.maxLength) || CONFIG.defaultMaxLength);
  if (maxLength < 50 || maxLength > CONFIG.maxLengthCeiling) {
    throw new Error(t_('err.maxLengthRange', { max: CONFIG.maxLengthCeiling }));
  }
  const roster = roster_('MODERATORS');
  const moderators = (input.moderators || [])
    .map(function (e) { return String(e).toLowerCase(); })
    .filter(function (e) { return roster.indexOf(e) !== -1; });

  const start = optionalTime_(input.scheduledStart, 'start');
  const end = optionalTime_(input.scheduledEnd, 'end');
  if (start && end && end <= start) throw new Error(t_('err.theScheduledEndMustBe'));
  const before = input.id ? getSession_(input.id) : null;
  const sameMinute = function (a, b) { return !!a && !!b && Math.floor(a / 60000) === Math.floor(b / 60000); };
  if (end && end <= Date.now() && !(before && sameMinute(before.scheduledEnd, end))) {
    throw new Error(t_('err.theScheduledEndHasAlready'));
  }

  const cooldown = input.cooldownSeconds === undefined || input.cooldownSeconds === ''
    ? CONFIG.cooldownSeconds : Math.round(Number(input.cooldownSeconds));
  if (!isFinite(cooldown) || cooldown < 0 || cooldown > CONFIG.cooldownCeiling) {
    throw new Error(t_('err.cooldownRange', { max: CONFIG.cooldownCeiling }));
  }

  const brandAccent = String(input.brandAccent || '');
  if (brandAccent && !HEX_RE.test(brandAccent)) throw new Error(t_('err.sessionAccentColorMustLook'));

  let preparedList = null;
  if (input.prepared !== undefined) {
    const lines = Array.isArray(input.prepared) ? input.prepared : String(input.prepared || '').split(/\r?\n/);
    if (lines.join('').length > CONFIG.maxPrepared * CONFIG.maxLengthCeiling) throw new Error(t_('err.thatListOfPreparedQuestions'));
    preparedList = lines
      .map(function (line) { return String(line || '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
    if (preparedList.length > CONFIG.maxPrepared) {
      throw new Error(t_('err.preparedTooMany', { max: CONFIG.maxPrepared }));
    }
    preparedList.forEach(function (q) {
      if (q.length < 5) throw new Error(t_('err.preparedTooShort', { text: q }));
      if (q.length > maxLength) throw new Error(t_('err.preparedTooLong', { max: maxLength, text: q.slice(0, 60) }));
    });
  }

  const fields = {
    name: name,
    heading: cleanText_(input.heading, 120) || 'Questions for the panel',
    room: cleanText_(input.room, 60),
    access: access,
    theme: theme,
    maxLength: maxLength,
    cooldownSeconds: cooldown,
    moderators: moderators,
    emailOnEnd: !!input.emailOnEnd,
    scheduledStart: start,
    scheduledEnd: end,
    brand: { orgName: cleanText_(input.brandOrgName, 80), accent: brandAccent.toLowerCase() },
    translatePrepared: input.translatePrepared !== false,
    roomQuestions: !!input.roomQuestions,
    guestPage: cleanGuestPageChoice_(input.guestPage),
    eventId: String(input.eventId || '')
  };
  if (fields.eventId && !getEvent_(fields.eventId)) throw new Error(t_('err.thatEventNoLongerExists'));

  let savedId = input.id;
  if (input.guestPage === undefined) delete fields.guestPage;
  if (input.eventId === undefined) delete fields.eventId;   // edits that don't mention it keep it
  if (dryRun) return input.id || null;
  if (input.id) {
    const was = getSession_(input.id);
    const now = updateSession_(input.id, function (s) {
      if (s.scheduledStart !== fields.scheduledStart) s.scheduleStarted = false;
      Object.keys(fields).forEach(function (k) { s[k] = fields[k]; });
      if (!s.eventId) delete s.eventId;
      if (s.access === 'link' && !s.linkKey) s.linkKey = newId_(16);
    });
    invalidateTopics_(input.id);
    const changed = was ? sessionChanges_(was, now) : '';
    if (changed || preparedList) audit_('Session edited', now, [changed, preparedList ? 'prepared questions (' + preparedList.length + ')' : ''].filter(Boolean).join(', '));
  } else {
    withLock_(function () {
      const session = fields;
      if (!session.eventId) delete session.eventId;
      session.id = newId_(8);
      session.linkKey = newId_(16);
      session.status = 'inactive';
      session.open = true;
      session.created = Date.now();
      session.createdBy = me;
      // New sessions appear at the top of the list.
      const orders = allSessions_().map(function (s) { return typeof s.order === 'number' ? s.order : 0; });
      session.order = orders.length ? Math.min.apply(null, orders) - 1 : 0;
      saveSession_(session);
      savedId = session.id;
    });
    audit_('Session created', getSession_(savedId), '');
  }
  if (preparedList) {
    setPrepared_(savedId, preparedList);
    // Translate them now, so they're ready when a facilitator adds one. If Gemini is down,
    // the every-minute run tries again.
    const saved = getSession_(savedId);
    if (saved.translatePrepared !== false && preparedList.length) {
      try { translateQuestions_(savedId); } catch (err) { console.error('Prepared translation for ' + savedId + ': ' + err); }
    }
  }
  return savedId;
}

/** Replaces a session's unused prepared questions; ones already added to the queue stay. */
function setPrepared_(sid, list) {
  withLock_(function () {
    const sheet = questionSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i >= 1; i--) {
      if (String(values[i][COLS.session - 1]) === sid && values[i][COLS.status - 1] === 'prepared') sheet.deleteRow(i + 1);
    }
    list.forEach(function (text) {
      sheet.appendRow([newId_(8), new Date(), 'prepared', sheetSafe_(text), 'prepared', '', '', '', sid]);
    });
    questionsChanged_();
  });
}

function cleanGuestPageChoice_(input) {
  const g = guestChoice_(input);
  // Blank means the Branding tab's address (or the built-in one), looked up when links are made.
  return { room: g.room, slide: g.slide, panel: g.panel, url: g.room || g.slide || g.panel ? cleanGuestPageUrl_(g.url) : '' };
}

function optionalTime_(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Number(value);
  if (!isFinite(ms) || ms <= 0) throw new Error(t_('err.scheduleNotADate', { which: label }));
  return Math.round(ms);
}

/**
 * Saves the order sessions appear in everywhere (admin list, queue switcher,
 * landing page). ids is the full list as dragged; unknown ids are ignored and
 * sessions left out keep their place after the ones given.
 */
function reorderSessions(ids) {
  requireAdmin_();
  if (!Array.isArray(ids)) throw new Error(t_('err.sendTheSessionsInTheir'));
  reorderSessions_(ids);
  return adminState();
}

/** Puts these sessions first, in this order; the rest keep their order after them. */
function reorderSessions_(ids) {
  withLock_(function () {
    const sessions = allSessions_();
    const byId = {};
    sessions.forEach(function (s) { byId[s.id] = s; });
    const seen = {};
    const ordered = [];
    ids.forEach(function (id) {
      id = String(id);
      if (byId[id] && !seen[id]) { seen[id] = true; ordered.push(byId[id]); }
    });
    sessions.forEach(function (s) { if (!seen[s.id]) ordered.push(s); });
    ordered.forEach(function (s, i) {
      if (s.order !== i) { s.order = i; saveSession_(s); }
    });
  });
}

function setSessionActive(sid, active) {
  requireAdmin_();
  updateSession_(sid, function (s) {
    if (s.status === 'ended') throw new Error(t_('err.thisSessionHasEndedAnd'));
    s.status = active ? 'active' : 'inactive';
    if (active && !s.started) s.started = Date.now();
  });
  audit_(active ? 'Session activated' : 'Session deactivated', getSession_(sid), '');
  return adminState();
}

/** which: 'screen' replaces the room screen (and slide) link; otherwise the participant link. */
function regenerateLink(sid, which) {
  requireAdmin_();
  updateSession_(sid, function (s) {
    if (which === 'screen') s.screenKey = newId_(16);
    // Phones that already joined keep their device token until it expires (6h).
    else s.linkKey = newId_(16);
  });
  audit_(which === 'screen' ? 'Room screen link replaced' : 'Participant link replaced', getSession_(sid), '');
  return adminState();
}

/**
 * Destructive admin actions require the session's name typed back, checked here
 * and not only in the page, so a stray click or a scripted call can't do it.
 */
function requireTypedName_(item, typed, what) {
  const norm = function (v) { return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
  if (!norm(typed) || norm(typed) !== norm(item.name)) {
    throw new Error(t_('err.typeTheNameToConfirm', { what: what || 'session', name: item.name }));
  }
}

function endSession(sid, typedName) {
  requireAdmin_();
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  requireTypedName_(session, typedName);
  const result = endSession_(sid);
  result.state = adminState();
  return result;
}

/**
 * Ends a session for good: closes intake, runs a final grouping pass so the
 * summary is translated, and emails moderators if the session asks for it.
 * No permission check — callers are endSession() and the schedule trigger.
 */
function endSession_(sid) {
  const session = updateSession_(sid, function (s) {
    if (s.status === 'ended') throw new Error(t_('err.thisSessionHasAlreadyEnded'));
    s.status = 'ended';
    s.open = false;
    s.ended = Date.now();
    s.nowAnswering = null;
  });
  // Questions sent a moment before the end still count: move them into the sheet first.
  try { flushInbox_(sid); } catch (err) { console.error('Inbox flush at end: ' + err); }
  props_().deleteProperty('TOKEN_' + sid);
  invalidateTopics_(sid);
  audit_('Session ended', session, '');

  let groupingNote = '';
  try {
    for (let pass = 0; pass < 8 && clusterSession_(sid) > 0; pass++) { /* drain in batches */ }
  } catch (err) {
    groupingNote = t_('end.groupingFailed');
    console.error('Final grouping for ' + sid + ': ' + err);
  }

  let emailed = 0;
  const recipients = summaryRecipients_(session);
  if (session.emailOnEnd && recipients.length && !session.loadTest) {
    try {
      emailed = sendSummary_(session, recipients);
    } catch (err) {
      // The session is already ended; keep the summary owed so the schedule retries it.
      noteSummaryFailure_(sid, err);
      groupingNote = (groupingNote ? groupingNote + ' ' : '') +
        t_('end.summaryFailed', { why: err.message || err });
    }
  }
  return { emailed: emailed, note: groupingNote };
}

function noteSummaryFailure_(sid, err) {
  console.error('Summary for ' + sid + ': ' + err);
  updateSession_(sid, function (s) {
    s.summaryPending = { error: String(err && err.message || err).slice(0, 200), attempts: ((s.summaryPending || {}).attempts || 0) + 1, last: Date.now() };
  });
}

/** Retries summaries that failed when their session ended: every 30 minutes, for a day. */
function retrySummaries_() {
  allSessions_().forEach(function (s) {
    const p = s.summaryPending;
    if (s.status !== 'ended' || !p || s.summarySent) return;
    if (Date.now() - p.last < 30 * 60 * 1000) return;
    if (Date.now() - (s.ended || 0) > 24 * 3600 * 1000) return;
    try {
      sendSummary_(s, summaryRecipients_(s));
    } catch (err) {
      noteSummaryFailure_(s.id, err);
    }
  });
}

/** Deletes a session that is not running, with its questions, topics, votes and logo. */
function deleteSession(sid, typedName) {
  requireAdmin_();
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  if (session.status === 'active') throw new Error(t_('err.deactivateOrEndTheSession'));
  requireTypedName_(session, typedName);
  deleteSession_(sid);
  audit_('Session deleted', session, 'with its questions, topics and votes');
  return adminState();
}

function deleteSession_(sid) {
  const inbox = INBOX_PREFIX + sid + '_';
  Object.keys(props_().getProperties()).forEach(function (k) { if (k.indexOf(inbox) === 0) props_().deleteProperty(k); });
  withLock_(function () {
    [[questionSheet_(), COLS.session], [topicSheet_(), 1]].forEach(function (pair) {
      const sheet = pair[0];
      const col = pair[1];
      const values = sheet.getDataRange().getValues();
      for (let i = values.length - 1; i >= 1; i--) {
        if (String(values[i][col - 1]) === sid) sheet.deleteRow(i + 1);
      }
    });
    ['SESSION_', 'TOKEN_', 'VOTES_'].forEach(function (p) { props_().deleteProperty(p + sid); });
    questionsChanged_();
    topicsChanged_();
  });
  setAsset_(sid, '');
  invalidateTopics_(sid);
}

function emailSummary(sid, recipients) {
  requireAdmin_();
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  const to = parseEmails_(recipients && recipients.length ? recipients : summaryRecipients_(session));
  if (!to.length) throw new Error(t_('err.addAtLeastOneRecipient'));
  const sent = sendSummary_(session, to);
  audit_('Summary emailed', session, 'to ' + to.join(', '));
  return sent;
}

/** options: { to: [emails], participant: bool, present: bool, moderate: bool } */
function emailLinks(sid, options) {
  requireAdmin_();
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  options = options || {};

  const to = options.toModerators ? facilitatorsFor_(session) : parseEmails_(options.to);
  if (!to.length) {
    throw new Error(t_(options.toModerators ? 'err.noFacilitatorsAssigned' : 'err.addAtLeastOneRecipient'));
  }
  checkQuota_(to.length);

  const links = sessionLinks_(session);
  const items = [];
  if (options.participant) {
    if (!links.participant) throw new Error(t_('err.inRoomSessionsHaveNo'));
    items.push([t_('mail.linkAsk'), links.participant, t_('mail.linkAskNote')]);
  }
  if (options.present) {
    items.push([t_('mail.linkPresent'), links.present, t_('mail.linkPresentNote')]);
  }
  if (options.moderate) {
    items.push([t_('mail.linkModerate'), links.moderate,
      t_('mail.linkModerateNote', { domain: domainOf_(ownerEmail_()) })]);
  }
  if (!items.length) throw new Error(t_('err.chooseAtLeastOneLink'));

  const brand = brand_(session);
  const html = emailShell_(brand, esc_(session.name),
    items.map(function (it) {
      return '<p style="margin:0 0 18px"><strong>' + esc_(it[0]) + '</strong><br>' +
        '<a href="' + esc_(it[1]) + '" style="color:' + brand.accent + '">' + esc_(it[1]) + '</a><br>' +
        '<span style="color:#5c6874">' + esc_(it[2]) + '</span></p>';
    }).join(''));

  // One message per recipient so addresses are never exposed to each other.
  to.forEach(function (address) {
    MailApp.sendEmail({ to: address, subject: t_('mail.linksSessionSubject', { name: session.name }),
      htmlBody: html, name: brand.orgName || 'Question Desk' });
  });
  audit_('Links emailed', session, 'to ' + to.join(', '));
  return to.length;
}

const ROLE_KEYS = { admin: 'ADMINS', moderator: 'MODERATORS', coordinator: 'COORDINATORS' };
const ROLE_NAMES = { admin: 'Administrator', moderator: 'QA Facilitator', coordinator: 'Event Coordinator' };

function addPerson(role, email) {
  const me = requireAdmin_();
  const key = ROLE_KEYS[role] || 'MODERATORS';
  const address = parseEmails_([email])[0];
  if (!address) throw new Error(t_('err.enterAnEmailAddress'));
  const domain = domainOf_(ownerEmail_());
  if (domainOf_(address) !== domain) {
    throw new Error(t_('err.outsideDomain', { domain: domain }));
  }
  withLock_(function () {
    const list = roster_(key);
    if (list.indexOf(address) === -1) list.push(address);
    props_().setProperty(key, list.join(','));
  });
  console.log(me + ' added ' + address + ' as ' + role);
  audit_((ROLE_NAMES[role] || ROLE_NAMES.moderator) + ' added', null, address);
  return adminState();
}

function removePerson(role, email) {
  const me = requireAdmin_();
  const address = String(email || '').toLowerCase();
  if (role === 'admin') {
    if (address === ownerEmail_()) throw new Error(t_('err.theScriptOwnerIsAlways'));
    if (address === me) throw new Error(t_('err.youCannotRemoveYourselfAsk'));
  }
  const key = ROLE_KEYS[role] || 'MODERATORS';
  withLock_(function () {
    props_().setProperty(key, roster_(key).filter(function (e) { return e !== address; }).join(','));
    if (role === 'moderator') {
      allSessions_().forEach(function (s) {
        const i = (s.moderators || []).indexOf(address);
        if (i !== -1) { s.moderators.splice(i, 1); saveSession_(s); }
      });
      allEvents_().forEach(function (ev) {
        const j = (ev.moderators || []).indexOf(address);
        if (j !== -1) { ev.moderators.splice(j, 1); saveEvent_(ev); }
      });
    }
    if (role === 'coordinator') {
      allEvents_().forEach(function (ev) {
        const j = (ev.coordinators || []).indexOf(address);
        if (j !== -1) { ev.coordinators.splice(j, 1); saveEvent_(ev); }
      });
    }
  });
  audit_((ROLE_NAMES[role] || ROLE_NAMES.moderator) + ' removed', null, address);
  return adminState();
}

// ---------------------------------------------------------------- branding

// ---------------------------------------------------------------- summary recipients

/** Organization default: the session's QA Facilitators and/or extra addresses. */
/**
 * The Session Summary Email Recipients (People tab): { extra: [addresses] }. `facilitators` is
 * always false: since 2.24.1 summaries go only to this list, never automatically to a session's
 * QA Facilitators, and sessions no longer choose their own recipients.
 */
function summaryDefaults_() {
  const saved = JSON.parse(props_().getProperty('SUMMARY_DEFAULTS') || 'null');
  return { facilitators: false, extra: (saved && saved.extra) || [] };
}

/** Validates the People tab list. Addresses may be outside the domain. */
function cleanSummaryRecipients_(input) {
  input = input || {};
  const extra = parseEmails_(Array.isArray(input.extra) ? input.extra : String(input.extra || ''));
  return { facilitators: false, extra: extra };
}

/**
 * Who gets a session's summary: the Session Summary Email Recipients on the People tab,
 * de-duplicated, at most CONFIG.maxRecipients. The same for every session (older sessions'
 * own recipient settings are ignored).
 */
function summaryRecipients_(session) {
  const list = [];
  summaryDefaults_().extra.forEach(function (e) { e = String(e).toLowerCase(); if (list.indexOf(e) === -1) list.push(e); });
  return list.slice(0, CONFIG.maxRecipients);
}

/** The languages sessions outside an event use (and any event that doesn't choose). */
function saveSiteLanguages(codes) {
  requireAdmin_();
  const clean = cleanLanguages_(codes);
  props_().setProperty('LANGUAGES', JSON.stringify(clean));
  allSessions_().forEach(function (x) { invalidateTopics_(x.id); });
  audit_('Site languages changed', null, clean.map(languageName_).join(', '));
  return adminState();
}

function saveSummaryDefaults(input) {
  requireAdmin_();
  // Nobody at all is allowed: then summaries go only to sessions with their own recipients.
  const clean = cleanSummaryRecipients_(input);
  props_().setProperty('SUMMARY_DEFAULTS', JSON.stringify(clean));
  audit_('Summary recipients changed', null, clean.extra.join(', ') || 'nobody');
  return adminState();
}

function saveBrand(input) {
  requireAdmin_();
  input = input || {};
  const color = function (value, fallback) {
    return HEX_RE.test(String(value || '')) ? String(value).toLowerCase() : fallback;
  };

  // Check everything first, so a rejected field never leaves a half-saved page.
  const favicon = String(input.faviconUrl || '').trim();
  if (favicon && !/^https:\/\/[^\s"'<>]+$/.test(favicon)) {
    throw new Error(t_('err.theTabIconMustBe'));
  }
  const guest = input.guestPageUrl === undefined ? null : cleanGuestPageUrl_(input.guestPageUrl);
  const url = String(input.publicUrl || '').trim();
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    if (!/script\.google\.com/.test(url)) {
      throw new Error(t_('err.thatLooksLikeAGuest'));
    }
    throw new Error(t_('err.theQuestionDeskGoogleAddress'));
  }

  props_().setProperty('BRAND', JSON.stringify({
    orgName: cleanText_(input.orgName, 80),
    accent: color(input.accent, DEFAULT_ACCENT),
    welcome: cleanText_(input.welcome, 200),
    footer: cleanText_(input.footer, 160),
    roomBgDark: color(input.roomBgDark, '#10171f'),
    roomBgLight: color(input.roomBgLight, '#ffffff'),
    faviconUrl: favicon.slice(0, 500)
  }));
  if (guest !== null) {
    if (guest) props_().setProperty('GUEST_PAGE_URL', guest);
    else props_().deleteProperty('GUEST_PAGE_URL');
  }
  if (url) props_().setProperty('PUBLIC_URL', url);
  else props_().deleteProperty('PUBLIC_URL');
  audit_('Branding saved', null, '');
  return adminState();
}

/**
 * Global branding, with a session's overrides applied when one is given.
 * Logos live in the Assets sheet and are served from the cache.
 */
function brand_(session) {
  const base = JSON.parse(props_().getProperty('BRAND') || '{}');
  const brand = {
    orgName: base.orgName || '',
    accent: base.accent || DEFAULT_ACCENT,
    welcome: base.welcome || '',
    footer: base.footer || '',
    roomBgDark: base.roomBgDark || '#10171f',
    roomBgLight: base.roomBgLight || '#ffffff',
    faviconUrl: base.faviconUrl || '',
    logo: asset_('global')
  };
  // Site → event → session: each level overrides only what it sets.
  const ev = session && session.eventId ? getEvent_(session.eventId) : null;
  if (ev) {
    const eb = ev.brand || {};
    ['orgName', 'accent', 'welcome', 'footer', 'roomBgDark', 'roomBgLight'].forEach(function (k) {
      if (eb[k]) brand[k] = eb[k];
    });
    if (ev.hasLogo) brand.logo = asset_('event:' + ev.id) || brand.logo;
    brand.eventName = ev.name;
  }
  if (session) {
    const own = session.brand || {};
    if (own.orgName) brand.orgName = own.orgName;
    if (own.accent) brand.accent = own.accent;
    if (session.hasLogo) brand.logo = asset_(session.id) || brand.logo;
  }
  return brand;
}

/** Logo arrives already downscaled by the browser. sid = null for the global logo. */
function cleanLogo_(dataUrl) {
  dataUrl = String(dataUrl || '');
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw new Error(t_('err.theLogoMustBeA'));
  }
  if (dataUrl.length > CONFIG.logoMaxChars) throw new Error(t_('err.thatLogoIsTooLarge'));
  return dataUrl;
}

function saveLogo(dataUrl, sid) {
  requireAdmin_();
  dataUrl = cleanLogo_(dataUrl);
  if (sid) {
    if (!getSession_(sid)) throw new Error('Session not found.');
    setAsset_(sid, dataUrl);
    updateSession_(sid, function (s) { s.hasLogo = true; });
  } else {
    setAsset_('global', dataUrl);
  }
  audit_(sid ? 'Session logo changed' : 'Site logo changed', sid ? getSession_(sid) : null, '');
  return adminState();
}

function removeLogo(sid) {
  requireAdmin_();
  if (sid) {
    setAsset_(sid, '');
    updateSession_(sid, function (s) { s.hasLogo = false; });
  } else {
    setAsset_('global', '');
  }
  audit_(sid ? 'Session logo removed' : 'Site logo removed', sid ? getSession_(sid) : null, '');
  return adminState();
}

function getSessionLogo(sid) {
  requireAdmin_();
  const session = getSession_(sid);
  return session && session.hasLogo ? asset_(sid) : '';
}

function asset_(key) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('asset:' + key);
  if (hit !== null) return hit === '-' ? '' : hit;

  let value = '';
  const sheet = assetSheet_();
  if (sheet) {
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === key) { value = values[i].slice(1).join(''); break; }
    }
  }
  cache.put('asset:' + key, value || '-', 21600);
  return value;
}

/** Stores a data URL across cells (50,000 characters per cell); '' deletes. */
function setAsset_(key, value) {
  const sheet = assetSheet_();
  if (!sheet) return;
  withLock_(function () {
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i >= 1; i--) {
      if (String(values[i][0]) === key) sheet.deleteRow(i + 1);
    }
    if (value) {
      const row = [key];
      // sheetSafe_: a chunk can start with '=' or '+' (base64), which Sheets would evaluate.
      for (let i = 0; i < value.length; i += 45000) row.push(sheetSafe_(value.slice(i, i + 45000)));
      sheet.appendRow(row);
    }
  });
  CacheService.getScriptCache().put('asset:' + key, value || '-', 21600);
}
