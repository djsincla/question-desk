/**
 * Question Desk server code: the room screen data and the QA Facilitator queue.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- room screen

/**
 * For the room screen: needs its key (or a signed-in QA Facilitator), and only ever
 * returns what the screen displays. `layout` 'qr' is the PowerPoint slide, whose QR code
 * has its own guest page choice.
 */
function getRoomScreen(sid, layout, key) {
  const session = getSession_(sid);
  if (!session) throw new Error('Session not found.');
  if (!screenKeyValid_(session, key) && !canModerate_(session, currentEmail_())) {
    throw new Error('This room screen link is out of date. Copy the new one from the Admin page.');
  }
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
    refreshInSeconds: 5,
    version: APP.version   // a long-open screen in a frame reloads when this changes
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
  if (session.roomQuestions) screen.asked = roomQuestionList_(session);
  return screen;
}

/**
 * What the room screen lists when a session turns that on: exactly what phones show (topics and
 * single questions a QA Facilitator put on phones), most Me too first, without the one being
 * answered (it's in the banner). Nothing a facilitator hasn't reviewed reaches the big screen.
 */
function roomQuestionList_(session) {
  const votes = votesFor_(session.id);
  const now = session.nowAnswering || {};
  const live = now.question ? singleKey_(now.question) : now.topic || '';
  return publicTopicsCached_(session).topics
    .filter(function (t) { return t.topic !== live; })
    .map(function (t) { return { labels: t.labels, count: t.questions + (votes[t.topic] || 0) }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, CONFIG.roomQuestionsMax);
}

// ---------------------------------------------------------------- moderation

function mySessions() {
  const email = currentEmail_();
  return sessionsFor_(email).map(function (s) {
    return { id: s.id, name: s.name, eventName: eventName_(s), status: s.status };
  });
}

function getBoard(sid) {
  const session = requireSession_(sid);
  flushInbox_(sid);   // this refresh is how new questions reach the sheet within seconds

  // The sheet-derived part is shared by every facilitator's refresh (see boardData_);
  // votes, the session's settings and anything about the viewer are always fresh.
  const data = boardData_(session);
  const votes = votesFor_(sid);
  data.topics.forEach(function (t) { t.votes = votes[t.topic] || 0; });
  data.topics.sort(function (a, b) {
    return (a.answered - b.answered) || (b.count + b.votes) - (a.count + a.votes);
  });
  const health = health_();
  const loose = data.unsorted;
  const shownQuestions = session.shownQuestions || [];
  loose.forEach(function (q) {
    q.shown = shownQuestions.indexOf(q.id) !== -1;
    q.votes = votes[singleKey_(q.id)] || 0;
  });

  return {
    session: {
      id: session.id,
      name: session.name,
      room: session.room || '',
      eventName: eventName_(session),
      status: session.status,
      access: session.access,
      links: sessionLinks_(session)
    },
    isAdmin: isAdmin_(),
    adminUrl: baseUrl_() + '?view=admin',
    topics: data.topics,
    unsorted: loose,
    // When grouping is failing (or questions have waited a while), sort the ungrouped ones by
    // a shared word so a facilitator isn't left with a flat list.
    groupingDown: (health.failures || 0) >= 2 ? (health.lastError || t_('queue.groupingFailing')) : '',
    // Only while automatic grouping is on and actually failing: with it off, or merely slow, the
    // queue doesn't talk about grouping (a flat list reads better than word-based guesses).
    looseGroups: loose.length >= 2 && session.autoGroup !== false && (health.failures || 0) >= 2
      ? keywordGroups_(loose) : null,
    open: session.open !== false,
    nowAnswering: session.nowAnswering && session.nowAnswering.topic ? session.nowAnswering.topic : null,
    nowAnsweringQuestion: session.nowAnswering && session.nowAnswering.question ? session.nowAnswering.question : null,
    nowAnsweringSince: session.nowAnswering ? session.nowAnswering.at || null : null,
    autoShowOnPhones: !!session.autoShowOnPhones,
    roomQuestions: !!session.roomQuestions,
    autoGroup: session.autoGroup !== false,
    merged: data.merged,
    mergedTranslations: data.mergedTranslations,
    dismissed: data.dismissed,
    prepared: data.prepared
  };
}

/**
 * Questions, topics, merged questions and prepared questions for the queue, read from both
 * sheets once and cached per session for a few seconds — however many facilitators have the
 * queue open. Every change to a session's questions or topics clears it (invalidateTopics_).
 */
function boardData_(session) {
  const sid = session.id;
  // Big sessions skip the cache (100 KB per entry).
  return cachedForSession_(sid, 'board', CONFIG.boardCacheSeconds, function () { return buildBoard_(session); }, 95000);
}

function buildBoard_(session) {
  const sid = session.id;

  const all = sessionRows_(sid, true);
  const topics = {};
  const loose = [];
  const dismissed = [];
  all.forEach(function (q) {
    if (q.status === 'prepared') return;
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
      topic: name, questions: list, count: list.length, votes: 0,
      answered: list.every(function (q) { return q.status === 'answered'; }),
      shown: !!(records[name] && records[name].shown),
      // What phones and the room screen show in other languages, so it is reviewed too.
      translations: translationList_(records[name] && records[name].labels, session)
    };
  });

  const merged = {};
  const mergedTranslations = {};
  Object.keys(records).forEach(function (t) {
    if (records[t].merged) {
      merged[t] = records[t].merged;
      mergedTranslations[t] = translationList_(records[t].mergedLabels, session);
    }
  });

  const data = {
    topics: grouped,
    unsorted: loose,
    merged: merged,
    mergedTranslations: mergedTranslations,
    dismissed: dismissed.sort(function (a, b) { return b.submitted - a.submitted; }),
    prepared: all.filter(function (q) { return q.status === 'prepared'; }).map(function (q) {
      return { id: q.id, text: q.text, lang: q.lang, translation: q.translation, translations: translationList_(q.translations, session) };
    })
  };
  return data;
}

function setStatus(sid, ids, status) {
  const session = requireOpenSession_(sid);
  flushInbox_(sid);
  if (['new', 'answered', 'dismissed'].indexOf(status) === -1) throw new Error(t_('err.unknownStatus'));

  const changedText = changeQuestions_(sid, ids, function (r) { return r[COLS.status - 1] !== 'prepared'; }, { status: status })
    .map(function (r) { return String(r[COLS.text - 1]); });
  invalidateTopics_(sid);
  // Answering or dismissing what's on the room screen takes it down.
  if (status !== 'new' && session.nowAnswering) {
    const now = session.nowAnswering;
    const rows = sessionRows_(sid);
    const done = now.question
      ? !rows.some(function (q) { return q.id === now.question && q.status === 'new'; })
      : !rows.some(function (q) { return q.topic === now.topic && q.status === 'new'; });
    if (done) updateSession_(sid, function (x) { x.nowAnswering = null; });
  }
  if (changedText.length) {
    const verb = status === 'answered' ? 'Marked answered' : status === 'dismissed' ? 'Dismissed' : 'Reopened';
    audit_(verb, session, changedText.length === 1 ? '"' + changedText[0].slice(0, 120) + '"' : changedText.length + ' questions');
  }
  return getBoard(sid);
}

function setBoardOpen(sid, open) {
  requireSession_(sid);
  const session = updateSession_(sid, function (s) { s.open = !!open; });
  audit_(open ? 'Questions resumed' : 'Questions paused', session, '');
  return getBoard(sid);
}

/**
 * Approves (or withdraws) a topic label for participants' phones, where people
 * can tap Me too. Nothing is shown to the audience until a moderator does this.
 */
function setTopicShown(sid, topic, shown) {
  const session = requireOpenSession_(sid);
  topic = String(topic || '');
  const exists = sessionRows_(sid).some(function (q) { return q.topic === topic && q.status !== 'dismissed'; });
  if (!exists) throw new Error(t_('err.thatTopicHasNoQuestions'));
  const update = {};
  update[topic] = { shown: !!shown };
  upsertTopics_(sid, update, true);
  invalidateTopics_(sid);
  audit_(shown ? 'Topic shown on phones' : 'Topic hidden from phones', session, topic);
  return getBoard(sid);
}

/**
 * Adds prepared questions to the live queue. They then go through translation and
 * grouping like any other question, timestamped when they were added.
 */
function usePrepared(sid, ids) {
  const session = requireOpenSession_(sid);
  if (!Array.isArray(ids) || !ids.length) throw new Error(t_('err.chooseAPreparedQuestionTo'));
  const added = changeQuestions_(sid, ids, function (r) { return r[COLS.status - 1] === 'prepared'; },
    { submitted: new Date(), status: 'new' }).length;
  if (!added) throw new Error(t_('err.thosePreparedQuestionsWereAlready'));
  invalidateTopics_(sid);
  audit_('Prepared question added', session, added + (added === 1 ? ' question' : ' questions'));
  return getBoard(sid);
}

/**
 * Shows (or hides) one question that isn't in a topic on participants' phones, where people
 * can tap Me too — the same as Show on phones for a topic, since a quiet session may never
 * be grouped. Its wording is translated into the session's languages first. A shown question
 * is kept out of automatic grouping so it doesn't vanish from phones mid-vote.
 */
function setQuestionShown(sid, questionId, shown) {
  const session = requireOpenSession_(sid);
  flushInbox_(sid);
  questionId = String(questionId || '');
  const question = sessionRows_(sid).filter(function (q) { return q.id === questionId; })[0];
  if (!question || question.status === 'dismissed') throw new Error(t_('err.thatQuestionIsNoLonger2'));
  if (question.topic && shown) throw new Error(t_('err.thatQuestionIsInA'));
  showSingle_(session, question, !!shown);
  invalidateTopics_(sid);
  audit_(shown ? 'Question shown on phones' : 'Question hidden from phones', session, '"' + (question.translation || question.text).slice(0, 120) + '"');
  return getBoard(sid);
}

/** Adds or removes a single question from the session's phone list (see setQuestionShown). */
function showSingle_(session, question, shown) {
  const sid = session.id;
  updateSession_(sid, function (s) {
    const list = (s.shownQuestions || []).filter(function (id) { return id !== question.id; });
    if (shown) list.push(question.id);
    // Session settings are one 9KB property: keep the newest few dozen.
    s.shownQuestions = list.slice(-40);
  });
  if (!shown) return;
  if (!question.topic) {
    changeQuestions_(sid, [question.id], function (r) { return r[COLS.grouping - 1] !== 'ungrouped'; }, { grouping: 'ungrouped' });
  }
  // Phones show it in their language; if Gemini is down they show the English wording.
  try { translateQuestions_(sid, [question.id]); } catch (err) { console.error('Translating a shown question: ' + err); }
}

/**
 * Shows a topic — or one question that isn't grouped (or is picked out of its topic) — on
 * the room screen and phones as the one being answered; both empty clears it. With the
 * session's "show on phones automatically" on, a topic is also approved for phones.
 */
function setNowAnswering(sid, topic, questionId) {
  const session = requireOpenSession_(sid);
  if (questionId) flushInbox_(sid);
  topic = topic ? String(topic).slice(0, 200) : '';
  questionId = questionId ? String(questionId) : '';
  let question = null;
  if (questionId) {
    question = sessionRows_(sid).filter(function (q) { return q.id === questionId; })[0];
    if (!question) throw new Error(t_('err.thatQuestionIsNoLonger2'));
  }
  updateSession_(sid, function (s) {
    s.nowAnswering = question ? { topic: '', question: question.id, at: Date.now() }
      : topic ? { topic: topic, at: Date.now() } : null;
  });
  if (topic && session.autoShowOnPhones && sessionRows_(sid).some(function (q) { return q.topic === topic && q.status !== 'dismissed'; })) {
    const update = {};
    update[topic] = { shown: true };
    upsertTopics_(sid, update, true);
  }
  if (question && !question.topic && session.autoShowOnPhones) {
    showSingle_(session, question, true);
  } else if (question) {
    // The room screen and phones show it in each language, not just English.
    try { translateQuestions_(sid, [question.id]); } catch (err) { console.error('Translating the question being answered: ' + err); }
  }
  invalidateTopics_(sid);
  const was = session.nowAnswering;
  audit_(topic || question ? 'Answer now' : 'Stopped answering', session,
    question ? '"' + (question.translation || question.text).slice(0, 120) + '"' : topic || (was ? was.topic || 'a question' : ''));
  return getBoard(sid);
}

/** The queue's "Show on phones automatically when answering" switch, per session. */
/** The queue's "List on the room screen" switch (also a session setting on the Admin page). */
function setRoomQuestions(sid, on) {
  const session = requireSession_(sid);
  updateSession_(sid, function (s) { s.roomQuestions = !!on; });
  audit_(on ? 'Room screen question list turned on' : 'Room screen question list turned off', session, '');
  return getBoard(sid);
}

function setAutoShowOnPhones(sid, on) {
  const session = requireSession_(sid);
  updateSession_(sid, function (s) { s.autoShowOnPhones = !!on; });
  audit_(on ? 'Automatic show on phones turned on' : 'Automatic show on phones turned off', session, '');
  return getBoard(sid);
}

/**
 * Groups questions by hand under a topic (new or existing), or moves them between topics.
 * Grouping by Gemini keeps running for the rest; it still translates these questions but
 * leaves their topic alone.
 */
function groupQuestions(sid, ids, topic) {
  const session = requireOpenSession_(sid);
  flushInbox_(sid);
  topic = cleanText_(topic, 80);
  if (!topic) throw new Error(t_('err.giveTheGroupATopic'));
  if (!Array.isArray(ids) || !ids.length) throw new Error(t_('err.chooseTheQuestionsToGroup'));
  // Clearing Grouping lets the every-minute run translate them again (it keeps the topic).
  const moved = changeQuestions_(sid, ids, function (r) { return r[COLS.status - 1] !== 'prepared'; },
    { topic: sheetSafe_(topic), grouping: '' }).length;
  if (!moved) throw new Error(t_('err.thoseQuestionsAreNoLonger'));
  // Single questions that were on phones: their topic goes on phones, with their Me too taps.
  const wanted = {};
  ids.forEach(function (id) { wanted[String(id)] = true; });
  const carried = (session.shownQuestions || []).filter(function (id) { return wanted[id]; });
  if (carried.length) {
    withLock_(function () {
      const votes = votesFor_(sid);
      carried.forEach(function (id) {
        votes[topic] = (votes[topic] || 0) + (votes[singleKey_(id)] || 0);
        delete votes[singleKey_(id)];
      });
      props_().setProperty('VOTES_' + sid, JSON.stringify(votes));
    });
    updateSession_(sid, function (s) {
      s.shownQuestions = (s.shownQuestions || []).filter(function (id) { return !wanted[id]; });
    });
    const update = {};
    update[topic] = { shown: true };
    upsertTopics_(sid, update, true);
  }
  invalidateTopics_(sid);
  audit_('Grouped by hand', session, moved + (moved === 1 ? ' question' : ' questions') + ' into "' + topic + '"');
  return getBoard(sid);
}

function groupNow(sid) {
  const session = requireSession_(sid);
  audit_('Group now', session, '');
  return clusterSession_(sid, true);
}

/** The queue's "Group automatically" switch, per session. */
function setAutoGroup(sid, on) {
  const session = requireSession_(sid);
  updateSession_(sid, function (s) { s.autoGroup = !!on; });
  audit_(on ? 'Automatic grouping turned on' : 'Automatic grouping turned off', session, '');
  return getBoard(sid);
}

/** Takes questions out of their topic. Automatic grouping leaves them alone afterwards. */
function ungroupQuestions(sid, ids) {
  const session = requireOpenSession_(sid);
  if (!Array.isArray(ids) || !ids.length) throw new Error(t_('err.chooseTheQuestionsToUngroup'));
  // Marked, so the every-minute grouping doesn't put them straight back.
  const moved = changeQuestions_(sid, ids, function (r) { return !!r[COLS.topic - 1]; }, { topic: '', grouping: 'ungrouped' }).length;
  invalidateTopics_(sid);
  if (moved) audit_('Ungrouped by hand', session, moved + (moved === 1 ? ' question' : ' questions'));
  return getBoard(sid);
}
