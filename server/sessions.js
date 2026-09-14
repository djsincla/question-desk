/**
 * Question Desk server code: sessions, guest page links and the rotating room codes.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- sessions

function props_() {
  return PropertiesService.getScriptProperties();
}

function getSession_(sid) {
  if (!ID_RE.test(String(sid || ''))) return null;
  const raw = props_().getProperty('SESSION_' + sid);
  return raw ? JSON.parse(raw) : null;
}

function saveSession_(session) {
  props_().setProperty('SESSION_' + session.id, JSON.stringify(session));
}

/** Sessions in the admin's chosen order; sessions never reordered sort newest first. */
function allSessions_() {
  const all = props_().getProperties();
  return Object.keys(all)
    .filter(function (k) { return /^SESSION_[a-f0-9]{8}$/.test(k); })
    .map(function (k) { return JSON.parse(all[k]); })
    .sort(function (a, b) {
      const oa = typeof a.order === 'number' ? a.order : -a.created;
      const ob = typeof b.order === 'number' ? b.order : -b.created;
      return oa - ob || b.created - a.created;
    });
}

function sessionsFor_(email) {
  return allSessions_().filter(function (s) { return canModerate_(s, email); });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function updateSession_(sid, mutate) {
  return withLock_(function () {
    const session = getSession_(sid);
    if (!session) throw new Error('Session not found.');
    mutate(session);
    saveSession_(session);
    return session;
  });
}

function newId_(length) {
  let id = '';
  while (id.length < length) id += Utilities.getUuid().replace(/-/g, '');
  return id.slice(0, length);
}

/** Address for staff-facing links (room screen, queue, admin), as Google reports it. */
function baseUrl_() {
  const configured = props_().getProperty('PUBLIC_URL');
  if (configured) return configured;
  return baseUrlDetected_();
}

/** Address for participant-facing links (the QR code, shareable links): always the public form. */
function participantBaseUrl_() {
  return publicAddress_(baseUrl_());
}

/**
 * Google may report the web app under a domain-scoped address — either
 * /a/macros/<domain>/s/… or /a/<domain>/macros/s/…. Those make anyone signed
 * into a different Google account sign in or request access, so everything a
 * participant opens uses the public /macros/s/… form. Staff links are left as reported.
 */
function publicAddress_(url) {
  return String(url || '')
    .replace(/\/a\/macros\/[^/]+\/s\//, '/macros/s/')
    .replace(/\/a\/[^/]+\/macros\/s\//, '/macros/s/');
}

function baseUrlDetected_() {
  return String(ScriptApp.getService().getUrl() || '')
    .replace(/\/a\/macros\/[^/]+\/s\//, '/macros/s/');
}

function sessionLinks_(session) {
  const base = baseUrl_();
  const key = screenKeyFor_(session);
  return {
    // Guest pages: public form, or through the session's guest page (see guestLink_).
    present: guestLink_(session, 'view=present&s=' + session.id + '&r=' + key, 'room'),
    moderate: base + '?view=moderate&s=' + session.id,
    panel: guestLink_(session, 'view=panel&s=' + session.id + '&r=' + key, 'panel'),
    // The add-in accepts either form (it always frames Google directly inside PowerPoint);
    // through the guest page, the same link also opens cleanly in any browser.
    slide: guestLink_(session, 'view=present&s=' + session.id + '&r=' + key + '&layout=qr', 'slide'),
    participant: session.access === 'link'
      ? guestLink_(session, 's=' + session.id + '&k=' + session.linkKey, 'any')
      : null
  };
}

/** The room screen key; sessions from before 2.6.0 get one the first time links are made. */
function screenKeyFor_(session) {
  if (!session.screenKey) {
    const saved = updateSession_(session.id, function (s) { if (!s.screenKey) s.screenKey = newId_(16); });
    session.screenKey = saved.screenKey;
  }
  return session.screenKey;
}

function screenKeyValid_(session, key) {
  // A session that has never had links made has no key yet, so nobody could hold a link.
  return !!session.screenKey && typeof key === 'string' && key === session.screenKey;
}

// ---------------------------------------------------------------- guest pages

/**
 * The guest page is a two-file wrapper (docs/join) hosted on any website. It embeds the
 * Question Desk page, so browsers that block third-party cookies (Safari, Firefox) send
 * Google no sign-in, which avoids Google's multi-account "Sorry, unable to open the file".
 * Chosen per session for each link; `where` is:
 *   'room'  — the room screen link and the QR code on the room screen
 *   'slide' — the PowerPoint slide link and the QR code on the slide
 *   'panel' — the panelist view link
 *   'any'   — the shareable questions link: on when the room screen or slide uses it
 * Returns '' when that link opens Question Desk directly.
 */
function guestPageFor_(session, where) {
  const g = guestChoice_(session && session.guestPage);
  const on = where === 'room' ? g.room : where === 'slide' ? g.slide : where === 'panel' ? g.panel : (g.room || g.slide);
  return on ? (g.url || orgGuestPage_()) : '';
}

/**
 * { room, slide, panel, url } from a stored or submitted choice. Before 2.4.4 it was
 * { mode: 'wrapper' } (everything); before 2.18 there was no panel choice and the panelist
 * view followed the room screen's.
 */
function guestChoice_(input) {
  input = input || {};
  const all = input.mode === 'wrapper';
  const room = all || input.room === true;
  return {
    room: room,
    slide: all || input.slide === true,
    panel: all || (input.panel === undefined ? room : input.panel === true),
    url: String(input.url || '')
  };
}

/** This project's public copy of docs/join; works for any Question Desk deployment. */
const DEFAULT_GUEST_PAGE = 'https://djsincla.github.io/question-desk/join/';

/** The Branding tab's guest page address, or the project's public copy when blank. */
function orgGuestPage_() {
  return props_().getProperty('GUEST_PAGE_URL') || DEFAULT_GUEST_PAGE;
}

/** Address for a guest page (participant page or room screen) with the given query. */
function guestLink_(session, query, where) {
  const direct = participantBaseUrl_();
  const wrapper = guestPageFor_(session, where);
  const deployment = (direct.match(/\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/) || [])[1];
  if (!wrapper || !deployment) return direct + '?' + query;
  return wrapper + (wrapper.indexOf('?') === -1 ? '?' : '&') + 'd=' + deployment + '&' + query;
}

/** Validates a guest page address: https, no query or fragment; folders get a trailing slash. */
function cleanGuestPageUrl_(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~%\/-]*)?$/i.test(url) || url.length > 300) {
    throw new Error('The guest page address must be an https:// link to the folder or page with the guest page files, without ? or #.');
  }
  if (!/\.html?$/i.test(url) && !/\/$/.test(url)) url += '/';
  return url;
}

// ---------------------------------------------------------------- entry tokens

/**
 * Current room token for an in-room session. Rotates on read once expired; the
 * previous token stays valid for one extra window so a scan mid-rotation works.
 */
function roomToken_(sid) {
  const key = 'TOKEN_' + sid;
  const windowMs = CONFIG.entryTokenSeconds * 1000;
  let tok = JSON.parse(props_().getProperty(key) || 'null');

  if (!tok || Date.now() - tok.issued > windowMs) {
    tok = withLock_(function () {
      const fresh = JSON.parse(props_().getProperty(key) || 'null');
      if (fresh && Date.now() - fresh.issued <= windowMs) return fresh;
      // Carry the old code over only if it was on screen a moment ago. After the screen was
      // closed for a while, an old code (say, a photo shared in a group chat) must stay dead.
      const recent = fresh && Date.now() - fresh.issued <= windowMs * 2;
      const next = {
        current: newId_(12),
        previous: recent ? fresh.current : '',
        previousIssued: recent ? fresh.issued : 0,
        issued: Date.now()
      };
      props_().setProperty(key, JSON.stringify(next));
      return next;
    });
  }
  return {
    token: tok.current,
    expiresIn: Math.max(1, Math.ceil((tok.issued + windowMs - Date.now()) / 1000))
  };
}

/**
 * The displayed token is valid for its own window plus one more. Without a room
 * screen polling, nothing rotates, so age is checked here rather than trusting
 * that rotation happened.
 */
function validCredential_(session, credential) {
  if (!credential || typeof credential !== 'string' || credential.length > 64) return false;
  if (session.access === 'link') return credential === session.linkKey;

  const tok = JSON.parse(props_().getProperty('TOKEN_' + session.id) || 'null');
  if (!tok) return false;
  const age = Date.now() - tok.issued;
  const windowMs = CONFIG.entryTokenSeconds * 1000;
  if (credential === tok.current) return age <= windowMs * 2;
  if (credential === tok.previous) {
    return age <= windowMs && !!tok.previousIssued && Date.now() - tok.previousIssued <= windowMs * 3;
  }
  return false;
}

function deviceValid_(sid, deviceId) {
  return DEVICE_RE.test(String(deviceId || '')) &&
    !!CacheService.getScriptCache().get('dev:' + sid + ':' + deviceId);
}
