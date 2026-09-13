/**
 * Question Desk
 * Anonymous audience Q&A for Google Workspace, with Gemini topic roll-up.
 *
 * Views, all served from one deployment:
 *   (no parameters)        branded landing page, with staff links when signed in
 *   ?s=ID&t=TOKEN          participant page, in-room session (token from the rotating QR)
 *   ?s=ID&k=KEY            participant page, shareable-link session
 *   ?view=present&s=ID     room screen: QR code for one session
 *   ?view=moderate&s=ID    facilitator queue for one session
 *   ?view=admin            sessions, people, branding, health
 *   POST /exec             load-test endpoint, off unless an admin starts a load test
 *
 * Run setUp() once from the editor before deploying, and again after any
 * change that adds an OAuth scope.
 */

/** Bump with every release; scripts/ship.sh tags git and publishes release notes from CHANGELOG.md. */
const APP = {
  version: '2.4.4',
  repo: 'https://github.com/djsincla/question-desk'
};

const CONFIG = {
  sheetName: 'Questions',
  topicSheetName: 'Topics',
  assetSheetName: 'Assets',
  model: 'gemini-3.5-flash',      // gemini-3.1-flash-lite is cheaper if cost matters
  moderatorLanguage: 'English',   // topic labels, translations and merged questions are written in this
  // Languages participants read topic labels and "Now answering" in. Codes match Ask.html.
  displayLanguages: { en: 'English', ko: 'Korean', es: 'Spanish' },
  defaultMaxLength: 300,          // per session, admin can change
  maxLengthCeiling: 1024,         // no session may allow more than this
  cooldownSeconds: 300,           // default wait between questions per phone; each session can change it
  cooldownCeiling: 3600,          // longest wait a session may set
  roomLimitPerMinute: 15,         // per session intake cap
  entryTokenSeconds: 150,         // how often an in-room QR rotates
  deviceTokenSeconds: 21600,      // 6h — CacheService maximum
  clusterBatchSize: 25,
  maxPrepared: 100,               // prepared questions per session
  topicCacheSeconds: 5,           // participant topic lists; a full room polls this (phones every 15 s)
  logoMaxChars: 60000,            // base64 data URL; pages load on weak venue wifi
  maxRecipients: 50,
  alertAfterFailures: 3,          // consecutive failed grouping runs before admins are emailed
  alertRepeatHours: 6,
  loadTestMinutes: 60
};

const COLS = {
  id: 1, submitted: 2, device: 3, text: 4,
  status: 5, topic: 6, lang: 7, translation: 8, session: 9
};

const HEADERS = ['ID', 'Submitted', 'Device', 'Question', 'Status', 'Topic',
                 'Language', 'Translation', 'Session'];

const TOPIC_HEADERS = ['Session', 'Topic', 'Merged question', 'Updated',
                       'Label translations', 'Merged translations', 'Shown to participants'];

const DEFAULT_ACCENT = '#1b5e5a';
const ID_RE = /^[a-f0-9]{8}$/;
const DEVICE_RE = /^[a-f0-9-]{36}$/;
const EMAIL_RE = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------- routing

function doGet(e) {
  const p = (e && e.parameter) || {};
  const view = p.view || 'ask';
  const sid = String(p.s || '');

  if (view === 'admin') {
    if (!isAdmin_()) return notice_('denied');
    return page_('Admin.html', 'Question Desk admin', {}, null);
  }

  // The room screen is public: anyone with its link can show it, signed in or not,
  // whatever Google account the browser uses. Only admin and queue need a login.
  if (view === 'present') {
    const screen = getSession_(sid);
    if (screen) {
      // layout=qr is the compact QR-only view used by the PowerPoint add-in (docs/addin).
      return page_('Present.html', screen.name, {
        sid: screen.id, theme: screen.theme, layout: p.layout === 'qr' ? 'qr' : 'full'
      }, screen);
    }
    if (!currentEmail_()) return notice_('noSession');
    return notice_('pick', view);
  }

  if (view === 'moderate') {
    const email = currentEmail_();
    if (!email || !(isAdmin_(email) || onRoster_('MODERATORS', email))) return notice_('denied');
    const session = getSession_(sid);
    if (!session) return notice_('pick', view);
    if (!canModerate_(session, email)) return notice_('denied');
    return page_('Moderate.html', session.name + ' — queue', { sid: session.id }, session);
  }

  if (view === 'ask' && !p.s) return home_();

  const session = getSession_(sid);
  return page_('Ask.html', 'Ask a question', {
    sid: session ? session.id : '',
    credential: String(p.t || p.k || '').slice(0, 64)
  }, session);
}

/** Renders a page with server data injected as a JSON literal (see BOOT in each file). */
function page_(file, title, boot, session) {
  const template = HtmlService.createTemplateFromFile(file);
  boot.brand = brand_(session);
  template.boot = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
  const output = template.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  if (boot.brand.faviconUrl) {
    // Google rejects some icon URLs; a bad icon must never take the page down.
    try { output.setFaviconUrl(boot.brand.faviconUrl); } catch (err) { console.error('Favicon: ' + err); }
  }
  return output;
}

/** Splash page at the bare app address. Staff see their live sessions; everyone else sees how to join. */
function home_() {
  const email = currentEmail_();
  const admin = isAdmin_(email);
  const staff = admin || onRoster_('MODERATORS', email);
  const base = baseUrl_();
  const orgName = brand_(null).orgName;
  return page_('Home.html', orgName ? orgName + ' — Question Desk' : 'Question Desk', {
    signedIn: !!email,
    staff: staff,
    adminUrl: admin ? base + '?view=admin' : '',
    domain: domainOf_(ownerEmail_()),
    signInUrl: 'https://accounts.google.com/AccountChooser?continue=' + encodeURIComponent(base),
    sessions: staff ? sessionsFor_(email)
      .filter(function (s) { return s.status !== 'ended' && !s.loadTest; })
      .map(function (s) {
        const links = sessionLinks_(s);
        return { name: s.name, status: s.status, present: links.present, moderate: links.moderate };
      }) : []
  }, null);
}

function notice_(mode, view) {
  if (mode === 'pick') {
    const email = currentEmail_();
    const base = baseUrl_();
    const links = sessionsFor_(email)
      .filter(function (s) { return s.status !== 'ended'; })
      .map(function (s) {
        return {
          label: s.name,
          note: s.status === 'active' ? 'Active' : 'Not active',
          href: view === 'present' ? sessionLinks_(s).present : base + '?view=' + view + '&s=' + s.id
        };
      });
    return page_('Denied.html', 'Choose a session', {
      heading: 'Choose a session',
      body: links.length ? 'Pick the session to open.' : 'You are not assigned to any open sessions.',
      links: links
    }, null);
  }
  if (mode === 'noSession') {
    return page_('Denied.html', 'Session not found', {
      heading: 'This room screen link is not valid',
      body: 'Check the link with whoever is running the session, or scan the code on the screen in the room to ask a question.',
      links: []
    }, null);
  }
  return page_('Denied.html', 'Not available', {
    heading: 'This view is for QA Facilitators',
    body: 'Sign in with an account listed as a QA Facilitator, or scan the code on the screen in the room to ask a question.',
    links: []
  }, null);
}

// ---------------------------------------------------------------- people

function currentEmail_() {
  return String(Session.getActiveUser().getEmail() || '').toLowerCase();
}

function ownerEmail_() {
  return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

function roster_(key) {
  return String(props_().getProperty(key) || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

function onRoster_(key, email) {
  return !!email && roster_(key).indexOf(email) !== -1;
}

function isAdmin_(email) {
  if (email === undefined) email = currentEmail_();
  return !!email && (email === ownerEmail_() || onRoster_('ADMINS', email));
}

function canModerate_(session, email) {
  if (isAdmin_(email)) return true;
  return onRoster_('MODERATORS', email) && (session.moderators || []).indexOf(email) !== -1;
}

function requireAdmin_() {
  if (!isAdmin_()) throw new Error('Only administrators can do that.');
  return currentEmail_();
}

function requireSession_(sid) {
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  if (!canModerate_(session, currentEmail_())) throw new Error('You are not a QA Facilitator for this session.');
  return session;
}

function adminEmails_() {
  const list = [ownerEmail_()];
  roster_('ADMINS').forEach(function (e) { if (list.indexOf(e) === -1) list.push(e); });
  return list.filter(Boolean);
}

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
  return {
    // Guest pages: public form, or through the session's guest page (see guestLink_).
    present: guestLink_(session, 'view=present&s=' + session.id, 'room'),
    moderate: base + '?view=moderate&s=' + session.id,
    // For the PowerPoint add-in, always direct: the add-in already embeds from outside Google.
    slide: participantBaseUrl_() + '?view=present&s=' + session.id + '&layout=qr',
    participant: session.access === 'link'
      ? guestLink_(session, 's=' + session.id + '&k=' + session.linkKey, 'any')
      : null
  };
}

// ---------------------------------------------------------------- guest pages

/**
 * The guest page is a two-file wrapper (docs/join) hosted on any website. It embeds the
 * Question Desk page, so browsers that block third-party cookies (Safari, Firefox) send
 * Google no sign-in, which avoids Google's multi-account "Sorry, unable to open the file".
 * Chosen per session for the room screen and the PowerPoint slide separately; `where` is
 * 'room', 'slide', or 'any' (a shareable questions link: either choice turns it on).
 * Returns '' when that place opens Question Desk directly.
 */
function guestPageFor_(session, where) {
  const g = guestChoice_(session && session.guestPage);
  const on = where === 'room' ? g.room : where === 'slide' ? g.slide : (g.room || g.slide);
  return on ? (g.url || orgGuestPage_()) : '';
}

/** { room, slide, url } from a stored or submitted choice; before 2.4.4 it was { mode, url }. */
function guestChoice_(input) {
  input = input || {};
  const both = input.mode === 'wrapper';
  return { room: both || input.room === true, slide: both || input.slide === true, url: String(input.url || '') };
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
      const next = {
        current: newId_(12),
        previous: fresh ? fresh.current : '',
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
  if (credential === tok.previous) return age <= windowMs;
  return false;
}

function deviceValid_(sid, deviceId) {
  return DEVICE_RE.test(String(deviceId || '')) &&
    !!CacheService.getScriptCache().get('dev:' + sid + ':' + deviceId);
}

// ---------------------------------------------------------------- participants

function participantState_(session) {
  if (!session) return { found: false };
  return {
    found: true,
    status: session.status,
    open: session.open !== false,
    access: session.access,
    heading: session.heading || 'Questions for the panel',
    maxLength: session.maxLength || CONFIG.defaultMaxLength
  };
}

function getSessionState(sid, deviceId) {
  const session = getSession_(sid);
  const state = participantState_(session);
  if (!session) return state;
  const validDevice = DEVICE_RE.test(String(deviceId || ''));
  state.deviceValid = deviceValid_(sid, deviceId);
  state.cooldownRemaining = validDevice ? cooldownRemaining_(session, deviceId) : 0;
  state.cooldownSeconds = cooldownFor_(session);
  return state;
}

/**
 * Exchange a room token or link key for a device token the browser keeps.
 * Device tokens are per session, so joining one session grants nothing in another.
 */
function claimDevice(sid, credential) {
  const session = getSession_(sid);
  if (!session) return { ok: false, reason: 'notFound' };
  if (session.status === 'ended') return { ok: false, reason: 'ended' };
  if (!validCredential_(session, credential)) return { ok: false, reason: 'expired' };

  const deviceId = Utilities.getUuid();
  CacheService.getScriptCache().put('dev:' + sid + ':' + deviceId, '1', CONFIG.deviceTokenSeconds);
  return { ok: true, deviceId: deviceId, state: getSessionState(sid, deviceId) };
}

function submitQuestion(sid, deviceId, text, credential) {
  return submitQuestion_(sid, deviceId, text, credential, false);
}

/** skipRoomCap is only ever true for load-test submissions through doPost. */
function submitQuestion_(sid, deviceId, text, credential, skipRoomCap) {
  // Reject oversized payloads before doing any work on them.
  if (typeof text !== 'string' || text.length > CONFIG.maxLengthCeiling * 2) {
    return { ok: false, reason: 'tooLong' };
  }

  const session = getSession_(sid);
  if (!session) return { ok: false, reason: 'notFound' };
  if (session.status === 'ended') return { ok: false, reason: 'ended' };
  if (session.status !== 'active') return { ok: false, reason: 'inactive' };
  if (session.open === false) return { ok: false, reason: 'closed' };

  const maxLength = session.maxLength || CONFIG.defaultMaxLength;
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length < 5) return { ok: false, reason: 'tooShort' };
  if (clean.length > maxLength) return { ok: false, reason: 'tooLong' };

  if (!DEVICE_RE.test(String(deviceId || ''))) deviceId = '';
  const cache = CacheService.getScriptCache();
  if (!deviceId || !cache.get('dev:' + sid + ':' + deviceId)) {
    if (!validCredential_(session, credential)) return { ok: false, reason: 'expired' };
  }

  const waiting = cooldownRemaining_(session, deviceId);
  if (waiting > 0) return { ok: false, reason: 'cooldown', waitSeconds: waiting };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return { ok: false, reason: 'busy' };
  }

  try {
    if (!skipRoomCap && !roomBudgetAvailable_(sid)) return { ok: false, reason: 'busy' };

    const id = newId_(8);
    questionSheet_().appendRow([
      id, new Date(), deviceId || 'unknown', sheetSafe_(clean), 'new', '', '', '', sid
    ]);
    questionsChanged_();
    if (deviceId) {
      // Store when the phone asked, not when its wait ends, so a session's wait can
      // be changed mid-event and apply to phones already waiting.
      cache.put('cool:' + sid + ':' + deviceId, String(Date.now()), CONFIG.cooldownCeiling + 60);
    }
    return { ok: true, id: id, cooldownSeconds: cooldownFor_(session) };
  } finally {
    lock.releaseLock();
  }
}

function cooldownFor_(session) {
  const value = session && session.cooldownSeconds;
  return typeof value === 'number' ? value : CONFIG.cooldownSeconds;
}

/** Seconds this phone must still wait, from the session's current setting. */
function cooldownRemaining_(session, deviceId) {
  if (!deviceId || !session) return 0;
  let askedAt = Number(CacheService.getScriptCache().get('cool:' + session.id + ':' + deviceId) || 0);
  if (!askedAt) return 0;
  // Before 2.1 the cache held when the wait ended; read those as an ask CONFIG.cooldownSeconds earlier.
  if (askedAt > Date.now()) askedAt -= CONFIG.cooldownSeconds * 1000;
  return Math.max(0, Math.ceil((askedAt + cooldownFor_(session) * 1000 - Date.now()) / 1000));
}

/** Per-session intake cap, so no single device can flood the queue. */
function roomBudgetAvailable_(sid) {
  const cache = CacheService.getScriptCache();
  const bucket = 'room:' + sid + ':' + Math.floor(Date.now() / 60000);
  const used = Number(cache.get(bucket) || 0);
  if (used >= CONFIG.roomLimitPerMinute) return false;
  cache.put(bucket, String(used + 1), 120);
  return true;
}

// ---------------------------------------------------------------- me too

/**
 * Topics a participant can support, labelled in every display language. Only
 * topic labels a moderator has approved are shown — never anyone's question
 * text — so nothing reaches the room unreviewed. Cached briefly: a full room polls.
 */
function getTopics(sid, deviceId) {
  const session = getSession_(sid);
  if (!session) return { ok: false, reason: 'notFound' };
  if (!deviceValid_(sid, deviceId)) return { ok: false, reason: 'expired' };

  const base = publicTopicsCached_(session);
  const votes = votesFor_(sid);
  const mine = myVotes_(sid, deviceId);
  return {
    ok: true,
    status: session.status,
    open: session.open !== false,
    cooldownRemaining: cooldownRemaining_(session, deviceId),
    nowAnswering: base.nowAnswering,
    topics: base.topics.map(function (t) {
      return {
        topic: t.topic,
        labels: t.labels,
        count: t.questions + (votes[t.topic] || 0),
        answered: t.answered,
        mine: mine.indexOf(t.topic) !== -1
      };
    }).sort(function (a, b) { return b.count - a.count; })
  };
}

/** Toggles this device's "me too" on a topic. */
function meToo(sid, deviceId, topic) {
  const session = getSession_(sid);
  if (!session) return { ok: false, reason: 'notFound' };
  if (session.status === 'ended') return { ok: false, reason: 'ended' };
  if (session.status !== 'active') return { ok: false, reason: 'inactive' };
  if (session.open === false) return { ok: false, reason: 'closed' };
  if (!deviceValid_(sid, deviceId)) return { ok: false, reason: 'expired' };

  topic = String(topic || '');
  const known = publicTopicsCached_(session).topics.some(function (t) { return t.topic === topic; });
  if (!known) return { ok: false, reason: 'unknownTopic' };

  const cache = CacheService.getScriptCache();
  const mineKey = 'votes:' + sid + ':' + deviceId;
  try {
    return withLock_(function () {
      const mine = JSON.parse(cache.get(mineKey) || '[]');
      const votes = votesFor_(sid);
      const at = mine.indexOf(topic);
      if (at === -1) {
        mine.push(topic);
        votes[topic] = (votes[topic] || 0) + 1;
      } else {
        mine.splice(at, 1);
        votes[topic] = Math.max(0, (votes[topic] || 0) - 1);
      }
      props_().setProperty('VOTES_' + sid, JSON.stringify(votes));
      cache.put(mineKey, JSON.stringify(mine), CONFIG.deviceTokenSeconds);
      return { ok: true, mine: at === -1, votes: votes[topic] };
    });
  } catch (err) {
    return { ok: false, reason: 'busy' };
  }
}

function votesFor_(sid) {
  return JSON.parse(props_().getProperty('VOTES_' + sid) || '{}');
}

function myVotes_(sid, deviceId) {
  return JSON.parse(CacheService.getScriptCache().get('votes:' + sid + ':' + deviceId) || '[]');
}

function publicTopicsCached_(session) {
  const cache = CacheService.getScriptCache();
  const key = 'topics:' + session.id;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const fresh = publicTopics_(session);
  cache.put(key, JSON.stringify(fresh), CONFIG.topicCacheSeconds);
  return fresh;
}

function invalidateTopics_(sid) {
  CacheService.getScriptCache().remove('topics:' + sid);
}

function publicTopics_(session) {
  const records = topicRecords_(session.id);
  const groups = {};
  sessionRows_(session.id).forEach(function (q) {
    if (!q.topic || q.status === 'dismissed') return;
    if (!records[q.topic] || !records[q.topic].shown) return;
    const g = groups[q.topic] = groups[q.topic] || { questions: 0, answered: 0 };
    g.questions++;
    if (q.status === 'answered') g.answered++;
  });
  return {
    nowAnswering: nowAnsweringView_(session, records),
    topics: Object.keys(groups).map(function (topic) {
      return {
        topic: topic,
        labels: displayLabels_(topic, records[topic] && records[topic].labels),
        questions: groups[topic].questions,
        answered: groups[topic].answered === groups[topic].questions
      };
    })
  };
}

/** Label in every display language, falling back to the moderator-language label. */
function displayLabels_(text, translations) {
  const out = {};
  translations = translations || {};
  Object.keys(CONFIG.displayLanguages).forEach(function (code) {
    out[code] = CONFIG.displayLanguages[code] === CONFIG.moderatorLanguage
      ? text
      : (translations[code] || text);
  });
  return out;
}

function translationCodes_() {
  return Object.keys(CONFIG.displayLanguages).filter(function (code) {
    return CONFIG.displayLanguages[code] !== CONFIG.moderatorLanguage;
  });
}

function nowAnsweringView_(session, records) {
  const now = session.nowAnswering;
  if (!now || !now.topic) return null;
  const rec = records[now.topic] || {};
  return {
    topic: now.topic,
    labels: displayLabels_(now.topic, rec.labels),
    merged: rec.merged ? displayLabels_(rec.merged, rec.mergedLabels) : null
  };
}

// ---------------------------------------------------------------- room screen

/**
 * Public, like the room screen itself: it only ever returns what the screen displays.
 * `layout` 'qr' is the PowerPoint slide, whose QR code has its own guest page choice.
 */
function getRoomScreen(sid, layout) {
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  const brand = brand_(session);
  delete brand.logo;   // the logo arrives with the page; this poll stays small
  const screen = {
    status: session.status,
    open: session.open !== false,
    theme: session.theme || 'dark',
    heading: session.heading || 'Questions for the panel',
    brand: brand,
    nowAnswering: session.nowAnswering ? nowAnsweringView_(session, topicRecords_(sid)) : null,
    url: null,
    refreshInSeconds: 5
  };
  if (session.status !== 'active') return screen;

  const where = layout === 'qr' ? 'slide' : 'room';
  if (session.access === 'link') {
    screen.url = guestLink_(session, 's=' + sid + '&k=' + session.linkKey, where);
  } else {
    const tok = roomToken_(sid);
    screen.url = guestLink_(session, 's=' + sid + '&t=' + tok.token, where);
    screen.refreshInSeconds = Math.min(5, tok.expiresIn + 1);
  }
  return screen;
}

// ---------------------------------------------------------------- moderation

function mySessions() {
  const email = currentEmail_();
  return sessionsFor_(email).map(function (s) {
    return { id: s.id, name: s.name, status: s.status };
  });
}

function getBoard(sid) {
  const session = requireSession_(sid);

  const rows = sessionRows_(sid);
  const votes = votesFor_(sid);
  const topics = {};
  const loose = [];

  const dismissed = [];
  rows.forEach(function (q) {
    if (q.status === 'dismissed') { dismissed.push(q); return; }
    if (!q.topic) { loose.push(q); return; }
    if (!topics[q.topic]) topics[q.topic] = [];
    topics[q.topic].push(q);
  });

  // Open questions first, answered ones sink to the bottom (kept so they can be reopened).
  const byAnswered = function (a, b) {
    return (a.status === 'answered') - (b.status === 'answered') || a.submitted - b.submitted;
  };
  loose.sort(byAnswered);

  const records = topicRecords_(sid);
  const grouped = Object.keys(topics).map(function (name) {
    const list = topics[name].sort(byAnswered);
    return {
      topic: name, questions: list, count: list.length, votes: votes[name] || 0,
      answered: list.every(function (q) { return q.status === 'answered'; }),
      shown: !!(records[name] && records[name].shown)
    };
  }).sort(function (a, b) {
    return (a.answered - b.answered) || (b.count + b.votes) - (a.count + a.votes);
  });

  const merged = {};
  Object.keys(records).forEach(function (t) { if (records[t].merged) merged[t] = records[t].merged; });

  return {
    session: {
      id: session.id,
      name: session.name,
      status: session.status,
      access: session.access,
      links: sessionLinks_(session)
    },
    isAdmin: isAdmin_(),
    adminUrl: baseUrl_() + '?view=admin',
    topics: grouped,
    unsorted: loose,
    open: session.open !== false,
    nowAnswering: session.nowAnswering ? session.nowAnswering.topic : null,
    merged: merged,
    dismissed: dismissed.sort(function (a, b) { return b.submitted - a.submitted; }),
    prepared: sessionRows_(sid, true)
      .filter(function (q) { return q.status === 'prepared'; })
      .map(function (q) { return { id: q.id, text: q.text }; })
  };
}

function setStatus(sid, ids, status) {
  const session = requireSession_(sid);
  if (session.status === 'ended') throw new Error('This session has ended.');
  if (['new', 'answered', 'dismissed'].indexOf(status) === -1) throw new Error('Unknown status.');

  const wanted = {};
  ids.forEach(function (id) { wanted[String(id)] = true; });
  withLock_(function () {
    const sheet = questionSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][COLS.session - 1]) === sid && wanted[String(values[i][COLS.id - 1])] &&
          values[i][COLS.status - 1] !== 'prepared') {
        sheet.getRange(i + 1, COLS.status).setValue(status);
      }
    }
    questionsChanged_();
  });
  invalidateTopics_(sid);
  return getBoard(sid);
}

function setBoardOpen(sid, open) {
  requireSession_(sid);
  updateSession_(sid, function (s) { s.open = !!open; });
  return getBoard(sid);
}

/**
 * Approves (or withdraws) a topic label for participants' phones, where people
 * can tap Me too. Nothing is shown to the audience until a moderator does this.
 */
function setTopicShown(sid, topic, shown) {
  const session = requireSession_(sid);
  if (session.status === 'ended') throw new Error('This session has ended.');
  topic = String(topic || '');
  const exists = sessionRows_(sid).some(function (q) { return q.topic === topic && q.status !== 'dismissed'; });
  if (!exists) throw new Error('That topic has no questions.');
  const update = {};
  update[topic] = { shown: !!shown };
  upsertTopics_(sid, update, true);
  invalidateTopics_(sid);
  return getBoard(sid);
}

/**
 * Adds prepared questions to the live queue. They then go through translation and
 * grouping like any other question, timestamped when they were added.
 */
function usePrepared(sid, ids) {
  const session = requireSession_(sid);
  if (session.status === 'ended') throw new Error('This session has ended.');
  if (!Array.isArray(ids) || !ids.length) throw new Error('Choose a prepared question to add.');
  const wanted = {};
  ids.forEach(function (id) { wanted[String(id)] = true; });
  let added = 0;
  withLock_(function () {
    const sheet = questionSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][COLS.session - 1]) === sid && wanted[String(values[i][COLS.id - 1])] &&
          values[i][COLS.status - 1] === 'prepared') {
        sheet.getRange(i + 1, COLS.submitted).setValue(new Date());
        sheet.getRange(i + 1, COLS.status).setValue('new');
        added++;
      }
    }
    questionsChanged_();
  });
  if (!added) throw new Error('Those prepared questions were already added or removed.');
  invalidateTopics_(sid);
  return getBoard(sid);
}

/** Shows a topic on the room screen and participants' phones; null clears it. */
function setNowAnswering(sid, topic) {
  const session = requireSession_(sid);
  if (session.status === 'ended') throw new Error('This session has ended.');
  updateSession_(sid, function (s) {
    s.nowAnswering = topic ? { topic: String(topic).slice(0, 200), at: Date.now() } : null;
  });
  invalidateTopics_(sid);
  return getBoard(sid);
}

function groupNow(sid) {
  requireSession_(sid);
  return clusterSession_(sid);
}

// ---------------------------------------------------------------- admin

function adminState() {
  const me = requireAdmin_();
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
    sessions: allSessions_().map(function (s) {
      const out = JSON.parse(JSON.stringify(s));
      out.links = sessionLinks_(s);
      out.guestPage = guestChoice_(s.guestPage);
      out.questionCount = counts[s.id] || 0;
      out.prepared = prepared[s.id] || [];
      out.summaryTo = summaryRecipients_(s);
      return out;
    }),
    brand: brand_(null),
    summaryDefaults: summaryDefaults_(),
    publicUrl: props_().getProperty('PUBLIC_URL') || '',
    guestPageUrl: props_().getProperty('GUEST_PAGE_URL') || '',
    guestPageDefault: DEFAULT_GUEST_PAGE,
    detectedUrl: baseUrlDetected_(),
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
  input = input || {};

  const name = cleanText_(input.name, 80);
  if (!name) throw new Error('Give the session a name.');
  const access = input.access === 'link' ? 'link' : 'room';
  const theme = input.theme === 'light' ? 'light' : 'dark';
  const maxLength = Math.round(Number(input.maxLength) || CONFIG.defaultMaxLength);
  if (maxLength < 50 || maxLength > CONFIG.maxLengthCeiling) {
    throw new Error('Question length must be between 50 and ' + CONFIG.maxLengthCeiling + ' characters.');
  }
  const roster = roster_('MODERATORS');
  const moderators = (input.moderators || [])
    .map(function (e) { return String(e).toLowerCase(); })
    .filter(function (e) { return roster.indexOf(e) !== -1; });

  const start = optionalTime_(input.scheduledStart, 'start');
  const end = optionalTime_(input.scheduledEnd, 'end');
  if (start && end && end <= start) throw new Error('The scheduled end must be after the start.');

  const cooldown = input.cooldownSeconds === undefined || input.cooldownSeconds === ''
    ? CONFIG.cooldownSeconds : Math.round(Number(input.cooldownSeconds));
  if (!isFinite(cooldown) || cooldown < 0 || cooldown > CONFIG.cooldownCeiling) {
    throw new Error('Time between questions must be between 0 and ' + CONFIG.cooldownCeiling + ' seconds.');
  }

  const brandAccent = String(input.brandAccent || '');
  if (brandAccent && !HEX_RE.test(brandAccent)) throw new Error('Session accent color must look like #1b5e5a.');

  let preparedList = null;
  if (input.prepared !== undefined) {
    const lines = Array.isArray(input.prepared) ? input.prepared : String(input.prepared || '').split(/\r?\n/);
    if (lines.join('').length > CONFIG.maxPrepared * CONFIG.maxLengthCeiling) throw new Error('That list of prepared questions is too long.');
    preparedList = lines
      .map(function (line) { return String(line || '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
    if (preparedList.length > CONFIG.maxPrepared) {
      throw new Error('Load at most ' + CONFIG.maxPrepared + ' prepared questions per session.');
    }
    preparedList.forEach(function (q) {
      if (q.length < 5) throw new Error('Prepared question is too short: ' + q);
      if (q.length > maxLength) throw new Error('A prepared question is longer than ' + maxLength + ' characters: ' + q.slice(0, 60) + '…');
    });
  }

  const fields = {
    name: name,
    heading: cleanText_(input.heading, 120) || 'Questions for the panel',
    access: access,
    theme: theme,
    maxLength: maxLength,
    cooldownSeconds: cooldown,
    moderators: moderators,
    emailOnEnd: !!input.emailOnEnd,
    summary: summarySetting_(input.summary),
    scheduledStart: start,
    scheduledEnd: end,
    brand: { orgName: cleanText_(input.brandOrgName, 80), accent: brandAccent.toLowerCase() },
    guestPage: cleanGuestPageChoice_(input.guestPage)
  };

  let savedId = input.id;
  if (input.summary === undefined) delete fields.summary;   // leave recipients as they were
  if (input.guestPage === undefined) delete fields.guestPage;
  if (input.id) {
    updateSession_(input.id, function (s) {
      if (s.scheduledStart !== fields.scheduledStart) s.scheduleStarted = false;
      Object.keys(fields).forEach(function (k) { s[k] = fields[k]; });
      if (s.access === 'link' && !s.linkKey) s.linkKey = newId_(16);
    });
    invalidateTopics_(input.id);
  } else {
    withLock_(function () {
      const session = fields;
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
  }
  if (preparedList) setPrepared_(savedId, preparedList);
  return adminState();
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
  return { room: g.room, slide: g.slide, url: g.room || g.slide ? cleanGuestPageUrl_(g.url) : '' };
}

function optionalTime_(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Number(value);
  if (!isFinite(ms) || ms <= 0) throw new Error('The scheduled ' + label + ' is not a valid date and time.');
  return Math.round(ms);
}

/**
 * Saves the order sessions appear in everywhere (admin list, queue switcher,
 * landing page). ids is the full list as dragged; unknown ids are ignored and
 * sessions left out keep their place after the ones given.
 */
function reorderSessions(ids) {
  requireAdmin_();
  if (!Array.isArray(ids)) throw new Error('Send the sessions in their new order.');
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
  return adminState();
}

function setSessionActive(sid, active) {
  requireAdmin_();
  updateSession_(sid, function (s) {
    if (s.status === 'ended') throw new Error('This session has ended and cannot be reopened.');
    s.status = active ? 'active' : 'inactive';
    if (active && !s.started) s.started = Date.now();
  });
  return adminState();
}

function regenerateLink(sid) {
  requireAdmin_();
  // Phones that already joined keep their device token until it expires (6h).
  updateSession_(sid, function (s) { s.linkKey = newId_(16); });
  return adminState();
}

/**
 * Destructive admin actions require the session's name typed back, checked here
 * and not only in the page, so a stray click or a scripted call can't do it.
 */
function requireTypedName_(session, typed) {
  const norm = function (v) { return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
  if (!norm(typed) || norm(typed) !== norm(session.name)) {
    throw new Error('Type the session name exactly to confirm: ' + session.name);
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
    if (s.status === 'ended') throw new Error('This session has already ended.');
    s.status = 'ended';
    s.open = false;
    s.ended = Date.now();
    s.nowAnswering = null;
  });
  props_().deleteProperty('TOKEN_' + sid);
  invalidateTopics_(sid);

  let groupingNote = '';
  try {
    for (let pass = 0; pass < 8 && clusterSession_(sid) > 0; pass++) { /* drain in batches */ }
  } catch (err) {
    groupingNote = 'Final grouping failed, so some questions may be untranslated.';
    console.error('Final grouping for ' + sid + ': ' + err);
  }

  let emailed = 0;
  const recipients = summaryRecipients_(session);
  if (session.emailOnEnd && recipients.length && !session.loadTest) {
    emailed = sendSummary_(session, recipients);
  }
  return { emailed: emailed, note: groupingNote };
}

/** Deletes a session that is not running, with its questions, topics, votes and logo. */
function deleteSession(sid, typedName) {
  requireAdmin_();
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  if (session.status === 'active') throw new Error('Deactivate or end the session before deleting it.');
  requireTypedName_(session, typedName);
  deleteSession_(sid);
  return adminState();
}

function deleteSession_(sid) {
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
  if (!to.length) throw new Error('Add at least one recipient.');
  return sendSummary_(session, to);
}

/** options: { to: [emails], participant: bool, present: bool, moderate: bool } */
function emailLinks(sid, options) {
  requireAdmin_();
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  options = options || {};

  const to = options.toModerators ? session.moderators.slice() : parseEmails_(options.to);
  if (!to.length) {
    throw new Error(options.toModerators ? 'This session has no QA Facilitators assigned.' : 'Add at least one recipient.');
  }
  checkQuota_(to.length);

  const links = sessionLinks_(session);
  const items = [];
  if (options.participant) {
    if (!links.participant) throw new Error('In-room sessions have no shareable link — people join by scanning the room screen.');
    items.push(['Ask a question', links.participant,
      'Anyone with this link can submit a question anonymously. If it says "Sorry, unable to open the file", open it in a private browsing window.']);
  }
  if (options.present) {
    items.push(['Room screen', links.present,
      'Open on the projector — no sign-in needed. Anyone with this link can see the join code, so share it only with the people running the room. Use a private browsing window on the projector computer, so no Google sign-in gets in the way.']);
  }
  if (options.moderate) {
    items.push(['QA Facilitator queue', links.moderate,
      'Questions grouped by topic. Requires signing in with an assigned ' + domainOf_(ownerEmail_()) + ' account.']);
  }
  if (!items.length) throw new Error('Choose at least one link to send.');

  const brand = brand_(session);
  const html = emailShell_(brand, esc_(session.name),
    items.map(function (it) {
      return '<p style="margin:0 0 18px"><strong>' + esc_(it[0]) + '</strong><br>' +
        '<a href="' + esc_(it[1]) + '" style="color:' + brand.accent + '">' + esc_(it[1]) + '</a><br>' +
        '<span style="color:#5c6874">' + esc_(it[2]) + '</span></p>';
    }).join(''));

  // One message per recipient so addresses are never exposed to each other.
  to.forEach(function (address) {
    MailApp.sendEmail({ to: address, subject: session.name + ' — Question Desk links', htmlBody: html, name: brand.orgName || 'Question Desk' });
  });
  return to.length;
}

function addPerson(role, email) {
  const me = requireAdmin_();
  const key = role === 'admin' ? 'ADMINS' : 'MODERATORS';
  const address = parseEmails_([email])[0];
  if (!address) throw new Error('Enter an email address.');
  const domain = domainOf_(ownerEmail_());
  if (domainOf_(address) !== domain) {
    throw new Error('Only @' + domain + ' accounts can sign in to this app. ' +
      'Google does not tell the app who is signed in from any other domain.');
  }
  withLock_(function () {
    const list = roster_(key);
    if (list.indexOf(address) === -1) list.push(address);
    props_().setProperty(key, list.join(','));
  });
  console.log(me + ' added ' + address + ' as ' + role);
  return adminState();
}

function removePerson(role, email) {
  const me = requireAdmin_();
  const address = String(email || '').toLowerCase();
  if (role === 'admin') {
    if (address === ownerEmail_()) throw new Error('The script owner is always an administrator.');
    if (address === me) throw new Error('You cannot remove yourself. Ask another administrator.');
  }
  const key = role === 'admin' ? 'ADMINS' : 'MODERATORS';
  withLock_(function () {
    props_().setProperty(key, roster_(key).filter(function (e) { return e !== address; }).join(','));
    if (role !== 'admin') {
      allSessions_().forEach(function (s) {
        const i = (s.moderators || []).indexOf(address);
        if (i !== -1) { s.moderators.splice(i, 1); saveSession_(s); }
      });
    }
  });
  return adminState();
}

// ---------------------------------------------------------------- branding

// ---------------------------------------------------------------- summary recipients

/** Organization default: the session's QA Facilitators and/or extra addresses. */
function summaryDefaults_() {
  const saved = JSON.parse(props_().getProperty('SUMMARY_DEFAULTS') || 'null');
  return saved || { facilitators: true, extra: [] };
}

/** Validates { facilitators, extra } from a form. Extra addresses may be outside the domain. */
function cleanSummaryRecipients_(input) {
  input = input || {};
  const extra = parseEmails_(Array.isArray(input.extra) ? input.extra : String(input.extra || ''));
  return { facilitators: input.facilitators !== false, extra: extra };
}

/** A session either uses the default or its own { facilitators, extra }. */
function summarySetting_(input) {
  if (!input || input.mode !== 'custom') return { mode: 'default' };
  const custom = cleanSummaryRecipients_(input);
  return { mode: 'custom', facilitators: custom.facilitators, extra: custom.extra };
}

/** Who gets this session's summary, de-duplicated, at most CONFIG.maxRecipients. */
function summaryRecipients_(session) {
  const setting = session.summary && session.summary.mode === 'custom' ? session.summary : summaryDefaults_();
  const list = [];
  const add = function (e) { e = String(e).toLowerCase(); if (list.indexOf(e) === -1) list.push(e); };
  if (setting.facilitators !== false) (session.moderators || []).forEach(add);
  (setting.extra || []).forEach(add);
  return list.slice(0, CONFIG.maxRecipients);
}

function saveSummaryDefaults(input) {
  requireAdmin_();
  // Nobody at all is allowed: then summaries go only to sessions with their own recipients.
  const clean = cleanSummaryRecipients_(input);
  props_().setProperty('SUMMARY_DEFAULTS', JSON.stringify(clean));
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
    throw new Error('The tab icon must be an https:// link to an image.');
  }
  const guest = input.guestPageUrl === undefined ? null : cleanGuestPageUrl_(input.guestPageUrl);
  const url = String(input.publicUrl || '').trim();
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    if (!/script\.google\.com/.test(url)) {
      throw new Error('That looks like a guest page address. Put it in "Guest page address" and leave the Question Desk Google address blank.');
    }
    throw new Error('The Question Desk Google address must look like https://script.google.com/macros/s/…/exec — or leave it blank.');
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
  if (session) {
    const own = session.brand || {};
    if (own.orgName) brand.orgName = own.orgName;
    if (own.accent) brand.accent = own.accent;
    if (session.hasLogo) brand.logo = asset_(session.id) || brand.logo;
  }
  return brand;
}

/** Logo arrives already downscaled by the browser. sid = null for the global logo. */
function saveLogo(dataUrl, sid) {
  requireAdmin_();
  dataUrl = String(dataUrl || '');
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw new Error('The logo must be a PNG, JPEG or WebP image.');
  }
  if (dataUrl.length > CONFIG.logoMaxChars) throw new Error('That logo is too large even after resizing.');
  if (sid) {
    if (!getSession_(sid)) throw new Error('Session not found.');
    setAsset_(sid, dataUrl);
    updateSession_(sid, function (s) { s.hasLogo = true; });
  } else {
    setAsset_('global', dataUrl);
  }
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
      for (let i = 0; i < value.length; i += 45000) row.push(value.slice(i, i + 45000));
      sheet.appendRow(row);
    }
  });
  CacheService.getScriptCache().put('asset:' + key, value || '-', 21600);
}

// ---------------------------------------------------------------- summaries

function sendSummary_(session, recipients) {
  const to = parseEmails_(recipients);
  if (!to.length) return 0;
  checkQuota_(to.length);

  const rows = sessionRows_(session.id);
  const records = topicRecords_(session.id);
  const votes = votesFor_(session.id);
  const tz = Session.getScriptTimeZone();
  const fmt = function (ms) { return ms ? Utilities.formatDate(new Date(ms), tz, 'MMM d, yyyy h:mm a') : '—'; };
  const merged = function (t) { return records[t] && records[t].merged ? records[t].merged : ''; };

  const kept = rows.filter(function (q) { return q.status !== 'dismissed'; });
  const groups = {};
  kept.forEach(function (q) {
    const t = q.topic || 'Not grouped';
    (groups[t] = groups[t] || []).push(q);
  });
  const weight = function (t) { return groups[t].length + (votes[t] || 0); };
  const order = Object.keys(groups).sort(function (a, b) { return weight(b) - weight(a); });

  const brand = brand_(session);
  let body = '<p style="color:#5c6874;margin:0 0 20px">' +
    esc_(fmt(session.started)) + ' – ' + esc_(fmt(session.ended)) + '<br>' +
    kept.length + ' questions in ' + order.length + ' topics' +
    (rows.length - kept.length ? ' · ' + (rows.length - kept.length) + ' dismissed' : '') +
    '</p>';

  order.forEach(function (topic) {
    body += '<h2 style="font-size:16px;margin:24px 0 8px;border-left:4px solid ' + brand.accent + ';padding-left:8px">' + esc_(topic) +
      ' <span style="color:#5c6874;font-weight:400">(' + groups[topic].length +
      (votes[topic] ? ' · ' + votes[topic] + ' me too' : '') + ')' +
      (records[topic] && records[topic].shown ? ' · shown on phones' : '') + '</span></h2>';
    if (merged(topic)) {
      body += '<p style="background:#fffdf5;border-left:3px solid #d9c27a;padding:8px 12px;margin:0 0 8px">' +
        esc_(merged(topic)) + '</p>';
    }
    body += '<ul style="margin:0;padding-left:20px">' + groups[topic].map(function (q) {
      // Always keep what was actually asked. Non-English questions show the English
      // translation and the original wording; untranslated ones say so.
      const small = '<br><span style="color:#5c6874;font-size:13px">';
      const tick = q.status === 'answered' ? '<span style="color:' + brand.accent + '">✓ </span>' : '';
      let item;
      if (!q.translation) {
        item = esc_(q.text) + small + 'Original wording — not translated' + (q.lang ? ' (' + esc_(q.lang) + ')' : '') + '</span>';
      } else if (sameLanguage_(q)) {
        item = esc_(q.text);
      } else {
        item = esc_(q.translation) + small + 'Original (' + esc_(q.lang || 'unknown language') + '): ' + esc_(q.text) + '</span>';
      }
      return '<li style="margin-bottom:8px">' + tick + item + '</li>';
    }).join('') + '</ul>';
  });

  const header = ['ID', 'Submitted', 'Status', 'Topic', 'Original language', 'Original question',
                  CONFIG.moderatorLanguage + ' translation', 'Merged question for topic', 'Me too (topic)',
                  'Topic shown on phones'];
  const csv = [header].concat(rows.map(function (q) {
    const translation = q.translation || (sameLanguage_(q) ? q.text : '(not translated)');
    return [q.id, fmt(q.submitted), q.status, q.topic, q.lang, q.text, translation, merged(q.topic),
            votes[q.topic] || 0, records[q.topic] && records[q.topic].shown ? 'yes' : 'no'];
  })).map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');

  const filename = session.name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'session';
  const blob = Utilities.newBlob('\ufeff' + csv, 'text/csv', filename + '-questions.csv');

  MailApp.sendEmail({
    to: to.join(','),
    subject: session.name + ' — questions summary',
    htmlBody: emailShell_(brand, esc_(session.name) + ' — questions', body),
    attachments: [blob],
    name: brand.orgName || 'Question Desk'
  });
  updateSession_(session.id, function (s) { s.summarySent = Date.now(); });
  return to.length;
}

/** True when the question was asked in the moderator language (no separate translation needed). */
function sameLanguage_(q) {
  return String(q.lang || '').toLowerCase() === CONFIG.moderatorLanguage.toLowerCase() ||
    (!!q.translation && q.translation === q.text);
}

function emailShell_(brand, title, inner) {
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16202b;max-width:640px;line-height:1.5">' +
    '<div style="border-top:4px solid ' + brand.accent + ';padding-top:12px">' +
    '<p style="color:#5c6874;font-size:13px;margin:0 0 4px">' + esc_(brand.orgName || 'Question Desk') + '</p>' +
    '<h1 style="font-size:20px;margin:0 0 16px">' + title + '</h1>' + inner +
    (brand.footer ? '<p style="color:#5c6874;font-size:13px;margin:28px 0 0;border-top:1px solid #d9dee3;padding-top:10px">' + esc_(brand.footer) + '</p>' : '') +
    '</div></div>';
}

function checkQuota_(needed) {
  const left = MailApp.getRemainingDailyQuota();
  if (left < needed) throw new Error('Daily email quota reached (' + left + ' left). Try again tomorrow.');
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
        'name (' + esc_(CONFIG.model) + ') was retired; a 400 or 403 usually means the API key.</p>')) {
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
  add('Gemini API key', key, key ? 'Set' : 'Missing — add GEMINI_API_KEY in Project Settings → Script Properties.');
  if (key) {
    const started = Date.now();
    const r = geminiRequest_('Health check. Set ok to true.', {
      type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok']
    });
    add('Gemini model ' + CONFIG.model, r.ok, r.ok ? 'Responded in ' + (Date.now() - started) + ' ms' : r.error);
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
        updateSession_(s.id, function (x) {
          x.scheduleStarted = true;
          x.status = 'active';
          if (!x.started) x.started = now;
        });
        changed++;
      }
    } catch (err) {
      console.error('Schedule for ' + s.id + ': ' + err);
    }
  });
  return changed;
}

// ---------------------------------------------------------------- Gemini

/** Trigger entry point: runs the schedule, then groups new questions in every active session. */
function clusterQuestions() {
  try {
    runSchedule_();
  } catch (err) {
    console.error('Schedule: ' + err);
  }

  let total = 0;
  let failure = null;
  allSessions_()
    .filter(function (s) { return s.status === 'active'; })
    .forEach(function (s) {
      try {
        total += clusterSession_(s.id);
      } catch (err) {
        failure = err;
        console.error('Grouping ' + s.id + ': ' + err);
      }
    });
  if (failure || total > 0) noteGroupingResult_(failure ? (failure.message || String(failure)) : null);
  return total;
}

/**
 * Assigns a topic to every question in one session that doesn't have one yet.
 * Existing topic names are passed in so labels stay stable between runs
 * instead of re-shuffling under the facilitator's eyes.
 */
function clusterSession_(sid) {
  const sheet = questionSheet_();
  questionsChanged_();
  const values = questionValues_();
  const pending = [];
  const existing = {};

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][COLS.session - 1]) !== sid) continue;
    const topic = values[i][COLS.topic - 1];
    if (topic) { existing[topic] = true; continue; }
    if (values[i][COLS.status - 1] === 'dismissed' || values[i][COLS.status - 1] === 'prepared') continue;
    if (pending.length < CONFIG.clusterBatchSize) {
      pending.push({ id: String(values[i][COLS.id - 1]), text: String(values[i][COLS.text - 1]) });
    }
  }
  if (!pending.length) return 0;

  const lang = CONFIG.moderatorLanguage;
  const codes = translationCodes_();
  const names = codes.map(function (c) { return CONFIG.displayLanguages[c]; });

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
    names.length ? '' : null,
    names.length ? 'Separately, for every topic label you use, give its translation into ' + names.join(' and ') + '.' : null,
    names.length ? 'Participants see these on their phones. They are for display only: always use the' : null,
    names.length ? lang + ' label in the assignments.' : null,
    '',
    'Existing topic labels:',
    Object.keys(existing).length ? Object.keys(existing).join('\n') : '(none yet)',
    '',
    'New questions:',
    pending.map(function (q) { return q.id + ': ' + q.text; }).join('\n'),
    '',
    'Do not invent questions and do not answer them.'
  ].filter(function (line) { return line !== null; }).join('\n');

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
  if (codes.length) schema.properties.labels = labelSchema_('topic', codes);

  const response = geminiRequest_(prompt, schema);
  if (!response.ok) throw new Error('Grouping failed: ' + response.error);
  const result = response.data;
  if (!result || !result.assignments) throw new Error('Grouping failed: Gemini returned no assignments.');

  const pendingIds = {};
  pending.forEach(function (q) { pendingIds[q.id] = true; });

  // Rows can move while Gemini is thinking (a deleted session, for one), so find
  // each question by id at write time, under the lock.
  let written = 0;
  withLock_(function () {
    const ids = sheet.getRange(1, COLS.id, sheet.getLastRow(), 1).getValues();
    const rowById = {};
    ids.forEach(function (r, i) { rowById[String(r[0])] = i + 1; });
    result.assignments.forEach(function (a) {
      const id = String(a.id);
      if (!pendingIds[id] || !rowById[id]) return;
      sheet.getRange(rowById[id], COLS.topic, 1, 3)
        .setValues([[sheetSafe_(a.topic), sheetSafe_(a.language || ''), sheetSafe_(a.translation || '')]]);
      written++;
    });
    questionsChanged_();
  });

  if (result.labels && result.labels.length) {
    const byTopic = {};
    result.labels.forEach(function (l) {
      if (l && l.topic && l.translations) byTopic[String(l.topic)] = { labels: pickCodes_(l.translations, codes) };
    });
    upsertTopics_(sid, byTopic, true);
  }
  invalidateTopics_(sid);
  return written;
}

function labelSchema_(field, codes) {
  const translations = { type: 'OBJECT', properties: {}, required: codes };
  codes.forEach(function (c) { translations.properties[c] = { type: 'STRING', description: CONFIG.displayLanguages[c] }; });
  const item = { type: 'OBJECT', properties: {}, required: [field, 'translations'] };
  item.properties[field] = { type: 'STRING' };
  item.properties.translations = translations;
  return { type: 'ARRAY', items: item };
}

function pickCodes_(obj, codes) {
  const out = {};
  codes.forEach(function (c) { if (obj[c]) out[c] = String(obj[c]).slice(0, 300); });
  return out;
}

/** Collapses one topic's questions into a single question to read aloud. */
function mergeTopic(sid, topic) {
  requireSession_(sid);

  const rows = sessionRows_(sid)
    .filter(function (q) { return q.topic === topic && q.status !== 'dismissed'; })
    .map(function (q) {
      const source = q.translation || q.text;
      return '- ' + source + (q.lang ? '  [asked in ' + q.lang + ']' : '');
    });

  if (!rows.length) return { ok: false };

  const codes = translationCodes_();
  const names = codes.map(function (c) { return CONFIG.displayLanguages[c]; });
  const prompt = [
    'These audience questions were all asked about "' + topic + '", by people',
    'writing in different languages.',
    'Write one question in ' + CONFIG.moderatorLanguage + ' that covers what they',
    'are collectively asking. Keep the audience\'s own concerns and specifics.',
    'Do not soften criticism, and do not add anything nobody asked.',
    'If they are not actually asking the same thing, say so instead of forcing',
    'them together. One sentence, under 40 words.',
    names.length ? 'Also translate that question into ' + names.join(' and ') + ' for the room screen,' : null,
    names.length ? 'just as faithfully: do not soften it in translation either.' : null,
    '',
    rows.join('\n')
  ].filter(function (line) { return line !== null; }).join('\n');

  const schema = {
    type: 'OBJECT',
    properties: { question: { type: 'STRING' } },
    required: ['question']
  };
  if (codes.length) {
    schema.properties.translations = labelSchema_('question', codes).items.properties.translations;
  }

  const response = geminiRequest_(prompt, schema);
  if (!response.ok || !response.data || !response.data.question) return { ok: false };

  const update = {};
  update[topic] = {
    merged: response.data.question,
    mergedLabels: pickCodes_(response.data.translations || {}, codes)
  };
  upsertTopics_(sid, update, false);
  invalidateTopics_(sid);
  return { ok: true, question: response.data.question };
}

/** Returns { ok, data } or { ok: false, status, error } with a readable cause. */
function geminiRequest_(prompt, schema) {
  const key = props_().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, error: 'GEMINI_API_KEY is not set in Script Properties.' };

  let response;
  try {
    response = UrlFetchApp.fetch(
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
  } catch (err) {
    return { ok: false, error: 'Could not reach Gemini: ' + err };
  }

  const code = response.getResponseCode();
  if (code !== 200) {
    const text = String(response.getContentText() || '');
    console.error('Gemini ' + code + ': ' + text);
    const hint = code === 404 ? ' — model ' + CONFIG.model + ' not found; it may have been retired. Update CONFIG.model.'
      : code === 429 ? ' — rate limited or out of quota.'
      : code === 400 || code === 401 || code === 403 ? ' — the API key was rejected or the request is invalid.'
      : '';
    return { ok: false, status: code, error: 'Gemini ' + code + hint + ' ' + text.slice(0, 200) };
  }

  try {
    const body = JSON.parse(response.getContentText());
    return { ok: true, data: JSON.parse(body.candidates[0].content.parts[0].text) };
  } catch (err) {
    console.error('Could not parse Gemini response: ' + err);
    return { ok: false, error: 'Could not parse Gemini response: ' + err };
  }
}

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
        lang: r[COLS.lang - 1] || '',
        translation: r[COLS.translation - 1] ? String(r[COLS.translation - 1]) : '',
        topic: r[COLS.topic - 1] ? String(r[COLS.topic - 1]) : '',
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
        if (!onlyMissingLabels || !Object.keys(current).length) {
          sheet.getRange(row, 5).setValue(JSON.stringify(u.labels));
        }
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
    if (!EMAIL_RE.test(e)) throw new Error('Not an email address: ' + e);
    if (!seen[e]) { seen[e] = true; out.push(e); }
  });
  if (out.length > CONFIG.maxRecipients) throw new Error('Send to at most ' + CONFIG.maxRecipients + ' people at a time.');
  return out;
}

/**
 * Run from the editor once, and again after updates that add permissions.
 * Safe to re-run: creates what is missing and migrates single-session data.
 * Admin only, since google.script.run can reach any public function.
 */
function setUp() {
  if (!isAdmin_()) throw new Error('Run setUp() from the Apps Script editor as the script owner.');
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
  } else if (!sheet.getRange(1, COLS.session).getValue()) {
    sheet.getRange(1, COLS.session).setValue('Session');
  }

  let topicSheet = ss.getSheetByName(CONFIG.topicSheetName);
  if (!topicSheet) {
    topicSheet = ss.insertSheet(CONFIG.topicSheetName);
    topicSheet.appendRow(TOPIC_HEADERS);
    topicSheet.setFrozenRows(1);
  } else {
    topicSheet.getRange(1, 1, 1, TOPIC_HEADERS.length).setValues([TOPIC_HEADERS]);
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
