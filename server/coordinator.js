/**
 * Question Desk server code: the Event Coordinator portal.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 *
 * Questions about running the event — parking, rooms, timing, interpretation — are picked out
 * as Gemini groups them (COLS.logistics). They stay in the session's queue, where a facilitator
 * can still answer them from the stage, and they also gather here, for the people who can
 * actually do something about them.
 */

// ---------------------------------------------------------------- the portal

/** Everything one event's coordinators see: their logistics questions, newest first. */
function getCoordinatorBoard(eid) {
  const ev = requireEvent_(eid);
  flushInbox_();
  const sessions = allSessions_().filter(function (s) { return s.eventId === eid && !s.loadTest; });
  const byId = {};
  sessions.forEach(function (s) { byId[s.id] = s; });

  const questions = [];
  sessions.forEach(function (s) {
    sessionRows_(s.id).forEach(function (q) {
      if (!q.logistics || q.status === 'dismissed') return;
      questions.push({
        id: q.id, session: s.name, room: s.room || '', sessionId: s.id,
        text: q.text, translation: q.translation || '', lang: q.lang || '',
        submitted: q.submitted, answered: q.status === 'answered', sorted: q.sorted
      });
    });
  });
  questions.sort(function (a, b) {
    return (a.sorted - b.sorted) || (b.submitted - a.submitted) || (a.id < b.id ? -1 : 1);
  });

  return {
    event: { id: ev.id, name: ev.name },
    isAdmin: isAdmin_(),
    adminUrl: isAdmin_() ? baseUrl_() + '?view=admin' : '',
    coordinators: coordinatorsFor_(ev),
    sessions: sessions.map(function (s) {
      return { id: s.id, name: s.name, room: s.room || '', status: s.status };
    }),
    questions: questions,
    waiting: questions.filter(function (q) { return !q.sorted; }).length,
    refreshInSeconds: 15
  };
}

/** A coordinator ticks one off, or puts it back. */
function setLogisticsSorted(eid, questionId, sorted) {
  const ev = requireEvent_(eid);
  const ids = [String(questionId || '')];
  const sessions = {};
  allSessions_().forEach(function (s) { if (s.eventId === eid) sessions[s.id] = true; });

  const changed = withLock_(function () {
    const sheet = questionSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][COLS.id - 1]) !== ids[0]) continue;
      if (!sessions[String(values[i][COLS.session - 1])]) break;   // another event's question
      if (!values[i][COLS.logistics - 1]) break;                   // not one of these
      sheet.getRange(i + 1, COLS.logistics).setValue(sorted ? 'sorted' : 'yes');
      questionsChanged_();
      return String(values[i][COLS.text - 1]);
    }
    return '';
  });
  if (!changed) throw new Error('That question is no longer in this event.');
  audit_(sorted ? 'Logistics question sorted' : 'Logistics question reopened',
    { id: ev.id, eventName: ev.name }, '"' + changed.slice(0, 120) + '"');
  return getCoordinatorBoard(eid);
}

/** The events this coordinator can open, for the picker and for staff links on the home page. */
function myEvents() {
  const email = currentEmail_();
  if (!email) return [];
  return eventsForCoordinator_(email).map(function (ev) {
    return { id: ev.id, name: ev.name, url: coordinatorLink_(ev) };
  });
}

function coordinatorLink_(ev) {
  return baseUrl_() + '?view=coordinator&e=' + ev.id;
}
