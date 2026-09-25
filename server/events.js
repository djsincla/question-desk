/**
 * Question Desk server code: events (a parent for sessions, with their own branding and languages) and the event tools: checklist, whole-event summary, duplicating, QR sheets.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- events

/**
 * An event groups sessions (a conference, a family night with several rooms). Stored as
 * EVENT_<8 hex> in Script Properties; sessions point to it with eventId. Its branding sits
 * between the site's and the session's: site → event → session.
 */
function getEvent_(eid) {
  if (!ID_RE.test(String(eid || ''))) return null;
  const raw = props_().getProperty('EVENT_' + eid);
  return raw ? JSON.parse(raw) : null;
}

function saveEvent_(ev) {
  props_().setProperty('EVENT_' + ev.id, JSON.stringify(ev));
}

/** Events in the admin's order; new ones first. */
function allEvents_() {
  const all = props_().getProperties();
  return Object.keys(all)
    .filter(function (k) { return /^EVENT_[a-f0-9]{8}$/.test(k); })
    .map(function (k) { return JSON.parse(all[k]); })
    .sort(function (a, b) {
      const oa = typeof a.order === 'number' ? a.order : -a.created;
      const ob = typeof b.order === 'number' ? b.order : -b.created;
      return oa - ob || b.created - a.created;
    });
}

function eventName_(session) {
  const ev = session && session.eventId ? getEvent_(session.eventId) : null;
  return ev ? ev.name : '';
}

/** input: { id?, name, orgName, accent, welcome, footer, roomBgDark, roomBgLight } — blank inherits the site's. */
function saveEvent(input) {
  const me = requireAdmin_();
  input = input || {};
  const name = cleanText_(input.name, 80);
  if (!name) throw new Error('Give the event a name.');
  const color = function (value, label) {
    const v = String(value || '').trim();
    if (v && !HEX_RE.test(v)) throw new Error(label + ' must be a color like #1b5e5a.');
    return v.toLowerCase();
  };
  const languages = input.languages === undefined || input.languages === null || (Array.isArray(input.languages) && !input.languages.length)
    ? null : cleanLanguages_(input.languages);
  const onList = function (key, list) {
    const roster = roster_(key);
    return list === undefined ? undefined : (list || [])
      .map(function (e) { return String(e).toLowerCase(); })
      .filter(function (e) { return roster.indexOf(e) !== -1; });
  };
  const moderators = onList('MODERATORS', input.moderators);
  const coordinators = onList('COORDINATORS', input.coordinators);
  const brand = {
    orgName: cleanText_(input.orgName, 80),
    accent: color(input.accent, 'The accent'),
    welcome: cleanText_(input.welcome, 200),
    footer: cleanText_(input.footer, 160),
    roomBgDark: color(input.roomBgDark, 'The dark background'),
    roomBgLight: color(input.roomBgLight, 'The light background')
  };
  let id = input.id;
  withLock_(function () {
    if (id) {
      const ev = getEvent_(id);
      if (!ev) throw new Error('Event not found.');
      ev.name = name;
      ev.brand = brand;
      if (input.languages !== undefined) ev.languages = languages;   // null: use the site's
      if (moderators !== undefined) ev.moderators = moderators;
      if (coordinators !== undefined) ev.coordinators = coordinators;
      saveEvent_(ev);
      audit_('Event edited', { id: ev.id, eventName: name }, '');
    } else {
      const orders = allEvents_().map(function (e) { return typeof e.order === 'number' ? e.order : 0; });
      id = newId_(8);
      saveEvent_({ id: id, name: name, brand: brand, languages: languages, moderators: moderators || [],
                   coordinators: coordinators || [], hasLogo: false, created: Date.now(), createdBy: me,
                   order: orders.length ? Math.min.apply(null, orders) - 1 : 0 });
      audit_('Event created', { id: id, eventName: name }, '');
    }
  });
  // Phones cache topic labels per session: languages may have changed.
  allSessions_().forEach(function (x) { if (x.eventId === id) invalidateTopics_(x.id); });
  const state = adminState();
  state.savedEventId = id;
  return state;
}

function reorderEvents(ids) {
  requireAdmin_();
  if (!Array.isArray(ids)) throw new Error('Send the events in their new order.');
  withLock_(function () {
    const events = allEvents_();
    const byId = {};
    events.forEach(function (e) { byId[e.id] = e; });
    const seen = {};
    const ordered = [];
    ids.forEach(function (id) { id = String(id); if (byId[id] && !seen[id]) { seen[id] = true; ordered.push(byId[id]); } });
    events.forEach(function (e) { if (!seen[e.id]) ordered.push(e); });
    ordered.forEach(function (e, i) { if (e.order !== i) { e.order = i; saveEvent_(e); } });
  });
  return adminState();
}

/** Deletes an event. Its sessions are kept and simply leave the event. */
function deleteEvent(eid, typedName) {
  requireAdmin_();
  const ev = getEvent_(eid);
  if (!ev) throw new Error('Event not found.');
  requireTypedName_(ev, typedName, 'event');
  withLock_(function () {
    allSessions_().forEach(function (s) {
      if (s.eventId === eid) { delete s.eventId; saveSession_(s); }
    });
    props_().deleteProperty('EVENT_' + eid);
  });
  setAsset_('event:' + eid, '');
  audit_('Event deleted', { id: eid, eventName: ev.name }, 'its sessions were kept');
  return adminState();
}

function saveEventLogo(eid, dataUrl) {
  requireAdmin_();
  if (!getEvent_(eid)) throw new Error('Event not found.');
  setAsset_('event:' + eid, cleanLogo_(dataUrl));
  withLock_(function () { const ev = getEvent_(eid); ev.hasLogo = true; saveEvent_(ev); });
  audit_('Event logo changed', { id: eid, eventName: getEvent_(eid).name }, '');
  return adminState();
}

function removeEventLogo(eid) {
  requireAdmin_();
  if (!getEvent_(eid)) throw new Error('Event not found.');
  setAsset_('event:' + eid, '');
  withLock_(function () { const ev = getEvent_(eid); ev.hasLogo = false; saveEvent_(ev); });
  audit_('Event logo removed', { id: eid, eventName: getEvent_(eid).name }, '');
  return adminState();
}

function getEventLogo(eid) {
  requireAdmin_();
  const ev = getEvent_(eid);
  return ev && ev.hasLogo ? asset_('event:' + eid) : '';
}

// ---------------------------------------------------------------- event tools

/** One email for a whole event: every session's topics and questions, and one CSV. */
/**
 * Emails each QA Facilitator of an event (its own and every session's) one message with the room
 * screen and queue links for each of their sessions in it. Ended sessions are left out.
 * Returns { facilitators, sessions }.
 */
function emailEventFacilitators(eid) {
  requireAdmin_();
  const ev = getEvent_(eid);
  if (!ev) throw new Error('Event not found.');
  const sessions = allSessions_().filter(function (s) { return s.eventId === eid && !s.loadTest && s.status !== 'ended'; })
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  if (!sessions.length) throw new Error('This event has no sessions that haven\'t ended.');
  const byPerson = {};
  sessions.forEach(function (s) {
    facilitatorsFor_(s).forEach(function (e) { (byPerson[e] = byPerson[e] || []).push(s); });
  });
  const people = Object.keys(byPerson);
  if (!people.length) throw new Error('No QA Facilitators are assigned to this event or its sessions.');
  checkQuota_(people.length);

  const tz = Session.getScriptTimeZone();
  const when = function (s) {
    if (!s.scheduledStart) return '';
    return Utilities.formatDate(new Date(s.scheduledStart), tz, 'EEE MMM d, h:mm a') +
      (s.scheduledEnd ? ' – ' + Utilities.formatDate(new Date(s.scheduledEnd), tz, 'h:mm a') : '');
  };
  const domain = domainOf_(ownerEmail_());
  const eventBrand = brand_(sessions[0]);
  people.forEach(function (address) {
    const list = byPerson[address];
    const body = '<p style="margin:0 0 18px">The ' + (list.length === 1 ? 'session' : list.length + ' sessions') +
      ' you are running in ' + esc_(ev.name) + '. Each link opens that session\'s question queue, and needs your ' +
      esc_(domain) + ' account.</p>' +
      list.map(function (s) {
        const links = sessionLinks_(s);
        const accent = brand_(s).accent;
        const link = function (label, url) {
          return '<br><span style="color:#5c6874">' + label + ':</span> <a href="' + esc_(url) + '" style="color:' + accent + '">' + esc_(url) + '</a>';
        };
        return '<p style="margin:0 0 20px;padding-left:10px;border-left:3px solid ' + accent + '"><strong>' + esc_(s.name) + '</strong>' +
          (s.room ? ' <span style="color:#5c6874">· ' + esc_(s.room) + '</span>' : '') +
          (when(s) ? '<br><span style="color:#5c6874">' + esc_(when(s)) + '</span>' : '') +
          link('QA Facilitator queue', links.moderate) + '</p>';
      }).join('');
    MailApp.sendEmail({
      to: address, subject: ev.name + ' — your Question Desk sessions',
      htmlBody: emailShell_(eventBrand, esc_(ev.name), body), name: eventBrand.orgName || 'Question Desk'
    });
  });
  audit_('Session links emailed to QA Facilitators', { id: ev.id, eventName: ev.name },
    people.length + (people.length === 1 ? ' QA Facilitator' : ' QA Facilitators') + ', ' + sessions.length + (sessions.length === 1 ? ' session' : ' sessions'));
  return { facilitators: people.length, sessions: sessions.length };
}

/** The review as email HTML, or a line saying why there isn't one. */
function reviewSection_(result, brand) {
  if (!result || !result.ok) return reviewProblem_(result && result.error);
  const r = result.review;
  const head = function (text) {
    return '<h2 style="font-size:15px;margin:18px 0 6px;color:#16202b">' + esc_(text) + '</h2>';
  };
  const note = function (text) {
    return '<p style="margin:0 0 10px;color:#3c4854">' + esc_(text) + '</p>';
  };
  let html = '<div style="background:#f5f7f9;border-left:4px solid ' + brand.accent + ';padding:14px 18px;margin:0 0 26px">' +
    '<h1 style="font-size:17px;margin:0 0 4px">What the questions say</h1>' +
    '<p style="margin:0 0 12px;color:#5c6874;font-size:13px">Written by Gemini from ' + result.reviewed +
    ' of the ' + result.questions + (result.questions === 1 ? ' question' : ' questions') + ' asked across ' +
    result.sessions + (result.sessions === 1 ? ' session' : ' sessions') + '. Read it as a starting point, not a verdict.</p>' +
    note(r.sentiment);

  if (r.themes && r.themes.length) {
    html += head('Themes worth acting on');
    html += '<ol style="margin:0 0 4px;padding-left:20px;color:#3c4854">' + r.themes.map(function (t) {
      return '<li style="margin-bottom:10px"><strong>' + esc_(t.title) + '</strong><br>' + esc_(t.what) +
        '<br><span style="color:#5c6874">Next time: ' + esc_(t.nextTime) + '</span></li>';
    }).join('') + '</ol>';
  }
  if (r.logistics && r.logistics.length) {
    html += head('Running the event');
    html += '<ul style="margin:0 0 4px;padding-left:20px;color:#3c4854">' + r.logistics.map(function (l) {
      return '<li style="margin-bottom:8px">' + esc_(l.issue) +
        '<br><span style="color:#5c6874">Next time: ' + esc_(l.nextTime) + '</span></li>';
    }).join('') + '</ul>';
  }
  if (r.individual && r.individual.count) {
    html += head('Questions about one person\'s situation');
    html += note(r.individual.count + (r.individual.count === 1 ? ' question was' : ' questions were') +
      ' about somebody\'s own circumstances. ' + r.individual.pattern);
    html += note('For everyone in that position: ' + r.individual.atScale);
  }
  if (r.sessionIdeas && r.sessionIdeas.length) {
    html += head('Sessions to consider next time');
    html += '<ul style="margin:0;padding-left:20px;color:#3c4854">' + r.sessionIdeas.map(function (idea) {
      return '<li style="margin-bottom:4px">' + esc_(idea) + '</li>';
    }).join('') + '</ul>';
  }
  return html + '</div>';
}

function reviewProblem_(why) {
  return '<p style="background:#f5f7f9;padding:12px 16px;margin:0 0 26px;color:#5c6874">' +
    'The questions are below, but no review was written this time. ' + esc_(why || '') + '</p>';
}

function emailEventSummary(eid, recipients) {
  requireAdmin_();
  const ev = getEvent_(eid);
  if (!ev) throw new Error('Event not found.');
  const sessions = allSessions_().filter(function (s) { return s.eventId === eid && !s.loadTest; });
  if (!sessions.length) throw new Error('This event has no sessions yet.');
  let to = recipients && recipients.length ? parseEmails_(recipients) : [];
  if (!to.length) {
    sessions.forEach(function (s) { summaryRecipients_(s).forEach(function (e) { if (to.indexOf(e) === -1) to.push(e); }); });
    to = to.slice(0, CONFIG.maxRecipients);
  }
  if (!to.length) throw new Error('Add at least one recipient.');
  checkQuota_(to.length);

  const brand = brand_(sessions[0]);
  // What the questions say about the event, before the questions themselves.
  let review = '';
  try {
    review = reviewSection_(eventReview_(eid), brand);
  } catch (err) {
    console.error('Event review: ' + err);
    review = reviewProblem_('The review could not be made: ' + err);
  }
  let body = '<p style="color:#5c6874;margin:0 0 8px">' + sessions.length + (sessions.length === 1 ? ' session' : ' sessions') + '</p>';
  let header = null;
  const csvRows = [];
  let questions = 0;
  sessions.forEach(function (s) {
    const content = summaryContent_(s, brand_(s));
    header = ['Session'].concat(content.header);
    questions += content.questions;
    body += '<h1 style="font-size:19px;margin:32px 0 4px;padding-top:12px;border-top:1px solid #d9dee3">' + esc_(s.name) + '</h1>' + content.body;
    content.rows.forEach(function (r) { csvRows.push([s.name].concat(r)); });
  });
  body = body.replace('</p>', ' · ' + questions + ' questions</p>') + '';
  body = body.replace('</p>', '</p>' + review);   // the review sits under the counts
  const csv = [header].concat(csvRows).map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
  const filename = ev.name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'event';
  const blob = Utilities.newBlob('\ufeff' + csv, 'text/csv', filename + '-questions.csv');
  to.forEach(function (address) {
    MailApp.sendEmail({
      to: address,
      subject: ev.name + ' — questions summary for the whole event',
      htmlBody: emailShell_(brand, esc_(ev.name) + ' — questions', body),
      attachments: [blob],
      name: brand.orgName || 'Question Desk'
    });
  });
  audit_('Event summary emailed', { id: eid, eventName: ev.name }, 'to ' + to.join(', '));
  return to.length;
}

/** A copy of a session's settings and unused prepared questions: inactive, unscheduled, new links. */
function duplicateSession(sid, eventId) {
  const me = requireAdmin_();
  const id = duplicateSession_(sid, eventId, me);
  audit_('Session duplicated', getSession_(id), 'from "' + getSession_(sid).name + '"');
  const state = adminState();
  state.newSessionId = id;
  return state;
}

function duplicateSession_(sid, eventId, me, keepName) {
  const src = getSession_(sid);
  if (!src) throw new Error('Session not found.');
  const input = sessionInput_(src);
  delete input.id;
  input.name = keepName ? src.name : cleanText_(src.name + ' (copy)', 80);
  input.scheduledStart = null;
  input.scheduledEnd = null;
  if (eventId !== undefined) input.eventId = eventId || '';
  input.prepared = sessionRows_(sid, true).filter(function (q) { return q.status === 'prepared'; }).map(function (q) { return q.text; });
  const id = saveSessionAs_(input, me, false);
  if (src.hasLogo) {
    const logo = asset_(sid);
    if (logo) { setAsset_(id, logo); updateSession_(id, function (x) { x.hasLogo = true; }); }
  }
  return id;
}

/** A copy of an event (branding, languages, logo, QA Facilitators) and of all its sessions. */
function duplicateEvent(eid) {
  const me = requireAdmin_();
  const ev = getEvent_(eid);
  if (!ev) throw new Error('Event not found.');
  const copy = createEvent_(cleanText_(ev.name + ' (copy)', 80), me);
  withLock_(function () {
    const fresh = getEvent_(copy.id);
    fresh.brand = JSON.parse(JSON.stringify(ev.brand || {}));
    fresh.languages = ev.languages ? ev.languages.slice() : null;
    fresh.moderators = (ev.moderators || []).slice();
    fresh.coordinators = (ev.coordinators || []).slice();
    saveEvent_(fresh);
  });
  if (ev.hasLogo) {
    const logo = asset_('event:' + eid);
    if (logo) {
      setAsset_('event:' + copy.id, logo);
      withLock_(function () { const x = getEvent_(copy.id); x.hasLogo = true; saveEvent_(x); });
    }
  }
  const ids = allSessions_().filter(function (s) { return s.eventId === eid && !s.loadTest; })
    .map(function (s) { return duplicateSession_(s.id, copy.id, me, true); });
  if (ids.length > 1) {
    reorderSessions_(ids.concat(allSessions_().map(function (x) { return x.id; }).filter(function (x) { return ids.indexOf(x) === -1; })));
  }
  audit_('Event duplicated', { id: copy.id, eventName: getEvent_(copy.id).name }, 'from "' + ev.name + '" with ' + ids.length + ' sessions');
  const state = adminState();
  state.savedEventId = copy.id;
  return state;
}

/**
 * Day-of readiness for an event: a row per session with what's set and what isn't.
 * Each check is { label, ok, detail }; warnings (ok: null) don't block but deserve a look.
 */
function eventChecklist(eid) {
  requireAdmin_();
  const ev = getEvent_(eid);
  if (!ev) throw new Error('Event not found.');
  const tz = Session.getScriptTimeZone();
  const fmt = function (ms) { return Utilities.formatDate(new Date(ms), tz, 'EEE MMM d, h:mm a'); };
  const now = Date.now();
  const health = health_();
  const trigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'clusterQuestions'; });
  const site = [
    { label: 'Question grouping runs every minute', ok: trigger, detail: trigger ? '' : 'Run setUp() in the Apps Script editor.' },
    { label: 'Gemini is set up', ok: !!props_().getProperty('GEMINI_API_KEY') && !health.failures,
      detail: !props_().getProperty('GEMINI_API_KEY') ? 'No Gemini API key: add one under Health & testing.' : health.failures ? 'Grouping failed ' + health.failures + ' times in a row: ' + (health.lastError || '') : '' },
    { label: 'Email quota', ok: MailApp.getRemainingDailyQuota() >= 20, detail: MailApp.getRemainingDailyQuota() + ' emails left today' }
  ];
  const sessions = allSessions_().filter(function (s) { return s.eventId === eid && !s.loadTest; }).map(function (s) {
    const links = sessionLinks_(s);
    const facilitators = facilitatorsFor_(s);
    const recipients = summaryRecipients_(s);
    const checks = [];
    if (s.status === 'ended') {
      checks.push({ label: 'Ended', ok: true, detail: s.summarySent ? 'Summary emailed ' + fmt(s.summarySent) : (s.summaryPending ? 'Summary not sent yet: ' + s.summaryPending.error : '') });
    } else {
      checks.push(s.status === 'active'
        ? { label: 'Active and taking questions', ok: s.open !== false, detail: s.open === false ? 'Questions are paused.' : '' }
        : s.scheduledStart && !s.scheduleStarted
          ? { label: 'Starts on its own', ok: s.scheduledStart > now, detail: fmt(s.scheduledStart) }
          : { label: 'Not active', ok: null, detail: 'Activate it on the Sessions tab when doors open.' });
      checks.push(s.scheduledEnd
        ? { label: 'Ends on its own', ok: s.scheduledEnd > now, detail: fmt(s.scheduledEnd) }
        : { label: 'No scheduled end', ok: null, detail: 'End it by hand afterwards.' });
      checks.push({ label: 'QA Facilitators', ok: facilitators.length > 0, detail: facilitators.join(', ') || 'Nobody can run the queue except administrators.' });
      checks.push({ label: 'Summary email', ok: !s.emailOnEnd ? null : recipients.length > 0,
        detail: !s.emailOnEnd ? 'Not emailed when it ends.' : recipients.length ? 'To ' + recipients.join(', ') : 'Turned on, but nobody would get it.' });
      const g = guestChoice_(s.guestPage);
      const uses = [g.room ? 'room screen' : '', g.slide ? 'PowerPoint slide' : '', g.panel ? 'panelist view' : ''].filter(Boolean);
      checks.push({ label: 'Guest page', ok: uses.length ? true : null,
        detail: uses.length ? 'For ' + uses.join(', ') : 'Off: browsers signed into several Google accounts may see "Sorry, unable to open the file".' });
      checks.push({ label: 'Prepared questions', ok: true, detail: String(sessionRows_(s.id, true).filter(function (q) { return q.status === 'prepared'; }).length) });
    }
    return {
      id: s.id, name: s.name, status: s.status, access: s.access,
      languages: languagesFor_(s).map(languageName_).join(', '),
      links: { present: links.present, slide: links.slide, panel: links.panel, moderate: links.moderate, participant: links.participant },
      checks: checks
    };
  });
  return { event: { id: ev.id, name: ev.name }, site: site, sessions: sessions, generated: now };
}
