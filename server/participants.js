/**
 * Question Desk server code: the participant page: joining, asking, and Me too.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

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

  // A full room submits at once. Each question is saved to its own Script Properties key —
  // durable, milliseconds, and no lock because no two submissions share a key — and written
  // to the sheet in batches by flushInbox_() (queue refreshes, the every-minute run, and
  // anything that needs every question). Never append to the sheet in parallel: a
  // 40-phone test lost 25 questions that way (2.14.1–2.15.0).
  const timing = { start: Date.now() };
  if (!skipRoomCap && !roomBudgetAvailable_(sid)) return { ok: false, reason: 'busy' };
  const id = newId_(8);
  const row = [id, Date.now(), deviceId || 'unknown', clean, sid];
  try {
    props_().setProperty(INBOX_PREFIX + sid + '_' + id, JSON.stringify(row));
  } catch (err) {
    // Settings storage full or refusing: write straight to the sheet, one at a time.
    console.error('Inbox write failed, appending directly: ' + err);
    try {
      withLock_(function () {
        questionSheet_().appendRow([id, new Date(row[1]), row[2], sheetSafe_(clean), 'new', '', '', '', sid]);
        questionsChanged_();
      });
    } catch (lockErr) {
      return { ok: false, reason: 'busy' };
    }
  }
  timing.saved = Date.now();
  if (deviceId) {
    // Store when the phone asked, not when its wait ends, so a session's wait can
    // be changed mid-event and apply to phones already waiting.
    cache.put('cool:' + sid + ':' + deviceId, String(Date.now()), CONFIG.cooldownCeiling + 60);
  }
  const res = { ok: true, id: id, cooldownSeconds: cooldownFor_(session) };
  if (skipRoomCap) {
    // Load test only: where the time went.
    res.timing = { saveMs: timing.saved - timing.start };
  }
  return res;
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

/**
 * Per-session intake cap, so no single device can flood the queue. Approximate under a burst
 * (the counter isn't locked, so parallel submissions can read the same count) — it's flood
 * protection, not an exact quota.
 */
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
  // This phone's own questions a facilitator marked answered (never anyone else's).
  const mineAnswered = (base.answeredByDevice || {})[String(deviceId)] || [];
  return {
    ok: true,
    mineAnswered: mineAnswered,
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
  // Identity-free flood cap, like questions: a script minting devices can't swamp the lock.
  const bucket = 'metoo:' + sid + ':' + Math.floor(Date.now() / 60000);
  if (Number(cache.get(bucket) || 0) >= CONFIG.meTooLimitPerMinute) return { ok: false, reason: 'busy' };
  try {
    return withLock_(function () {
      cache.put(bucket, String(Number(cache.get(bucket) || 0) + 1), 120);
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
  return cachedForSession_(session.id, 'topics', CONFIG.topicCacheSeconds, function () {
    const fresh = publicTopics_(session);
    // Which devices' questions are answered rides along, so phones can show "Answered" on
    // their own questions without a sheet read per poll. Only ever handed back per device.
    fresh.answeredByDevice = {};
    questionValues_().slice(1).forEach(function (r) {
      if (String(r[COLS.session - 1]) !== session.id || r[COLS.status - 1] !== 'answered') return;
      const d = String(r[COLS.device - 1]);
      (fresh.answeredByDevice[d] = fresh.answeredByDevice[d] || []).push(String(r[COLS.id - 1]));
    });
    return fresh;
  });
}

/** Clears a session's cached phone topic list and queue board, after anything changes them. */
function invalidateTopics_(sid) {
  const cache = CacheService.getScriptCache();
  // A new version first: a request that read the sheet before this change and caches its result
  // afterwards tags it with the old version, so it's never served (see cachedForSession_).
  cache.put('ver:' + sid, newId_(12), 21600);
  cache.remove('topics:' + sid);
  cache.remove('board:' + sid);
}

/**
 * A session's cached value (the queue board, the phone topic list), or build() it and cache it.
 * Every entry carries the session's cache version from before the sheet was read; a change
 * (invalidateTopics_) replaces the version, so an entry built from data read before the change
 * is ignored even if it's written after. Without this, dismissed questions reappeared in the
 * queue for up to 30 seconds when a refresh raced a dismissal.
 */
function cachedForSession_(sid, name, seconds, build, maxLength) {
  const cache = CacheService.getScriptCache();
  const key = name + ':' + sid;
  const got = cache.getAll(['ver:' + sid, key]);
  let version = got['ver:' + sid];
  if (!version) {
    version = newId_(12);
    cache.put('ver:' + sid, version, 21600);
  }
  if (got[key]) {
    try {
      const entry = JSON.parse(got[key]);
      if (entry && entry.v === version) return entry.data;
    } catch (err) { /* unreadable: rebuild */ }
  }
  const data = build();
  const json = JSON.stringify({ v: version, data: data });
  if (!maxLength || json.length < maxLength) cache.put(key, json, seconds);
  return data;
}

function publicTopics_(session) {
  const records = topicRecords_(session.id);
  const groups = {};
  const singles = [];
  const shownQuestions = session.shownQuestions || [];
  sessionRows_(session.id).forEach(function (q) {
    if (q.status === 'dismissed') return;
    // A question that isn't in a topic, shown on phones by a facilitator: its own entry.
    if (!q.topic) {
      if (shownQuestions.indexOf(q.id) !== -1 && q.status !== 'answered') singles.push(q);
      return;
    }
    if (!records[q.topic] || !records[q.topic].shown) return;
    const g = groups[q.topic] = groups[q.topic] || { questions: 0, answered: 0 };
    g.questions++;
    if (q.status === 'answered') g.answered++;
  });
  return {
    nowAnswering: nowAnsweringView_(session, records),
    // Topics whose questions are all answered leave phones: there's nothing left to support.
    topics: Object.keys(groups).filter(function (topic) { return groups[topic].answered < groups[topic].questions; }).map(function (topic) {
      return {
        topic: topic,
        labels: displayLabels_(topic, records[topic] && records[topic].labels, session),
        questions: groups[topic].questions,
        answered: groups[topic].answered === groups[topic].questions
      };
    }).concat(singles.map(function (q) {
      return {
        topic: singleKey_(q.id),
        labels: displayLabels_(q.translation || q.text, q.translations, session),
        questions: 1,
        answered: false
      };
    }))
  };
}

/** Me too key for a single question shown on phones (topic names never look like this). */
function singleKey_(questionId) {
  return 'q:' + questionId;
}

/** Label in each of the session's languages, falling back to the moderator-language label. */
function displayLabels_(text, translations, session) {
  const out = {};
  translations = translations || {};
  languagesFor_(session).forEach(function (code) {
    out[code] = languageName_(code) === CONFIG.moderatorLanguage ? text : (translations[code] || text);
  });
  return out;
}

function languageName_(code) {
  return CONFIG.languages[code] ? CONFIG.languages[code].name : code;
}

/** Validated language codes: known, unique, English first, at most CONFIG.maxLanguages. */
function cleanLanguages_(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/))
    .map(function (c) { return String(c || '').trim().toLowerCase(); })
    .filter(Boolean);
  const out = ['en'];
  list.forEach(function (c) {
    if (!CONFIG.languages[c]) throw new Error(t_('err.unknownLanguage', { code: c, codes: Object.keys(CONFIG.languages).join(', ') }));
    if (out.indexOf(c) === -1) out.push(c);
  });
  if (out.length > CONFIG.maxLanguages) throw new Error(t_('err.tooManyLanguages', { max: CONFIG.maxLanguages }));
  return out;
}

/** The site's default languages (Branding tab). */
function siteLanguages_() {
  const saved = JSON.parse(props_().getProperty('LANGUAGES') || 'null');
  return saved && saved.length ? saved : CONFIG.defaultLanguages.slice();
}

/** A session's languages: its event's choice, or the site default. */
function languagesFor_(session) {
  const ev = session && session.eventId ? getEvent_(session.eventId) : null;
  return ev && ev.languages && ev.languages.length ? ev.languages.slice() : siteLanguages_();
}

/** [{ code, name, native }] for a page's language buttons and text. */
function languageList_(session) {
  return languagesFor_(session).map(function (code) {
    return { code: code, name: CONFIG.languages[code].name, native: CONFIG.languages[code].native };
  });
}

/** [{ language: 'Korean', text }] for each display language that has its own translation. */
function translationList_(labels, session) {
  labels = labels || {};
  return translationCodes_(session)
    .filter(function (code) { return labels[code]; })
    .map(function (code) { return { language: languageName_(code), text: String(labels[code]) }; });
}

/** The session's languages other than the moderator's, which Gemini translates labels into. */
function translationCodes_(session) {
  return languagesFor_(session).filter(function (code) { return languageName_(code) !== CONFIG.moderatorLanguage; });
}

function nowAnsweringView_(session, records) {
  const now = session.nowAnswering;
  if (now && now.question) {
    // One question picked by the facilitator: its English wording (translation when it
    // was asked in another language). Languages without a translation show the same.
    const q = sessionRows_(session.id).filter(function (x) { return x.id === now.question; })[0];
    if (!q) return null;
    const words = q.translation || q.text;
    return { topic: '', question: true, labels: displayLabels_(words, q.translations, session), merged: null, since: now.at || null };
  }
  if (!now || !now.topic) return null;
  const rec = records[now.topic] || {};
  return {
    topic: now.topic,
    labels: displayLabels_(now.topic, rec.labels, session),
    merged: rec.merged ? displayLabels_(rec.merged, rec.mergedLabels, session) : null,
    since: now.at || null
  };
}
