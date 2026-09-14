/**
 * Question Desk server code: administrators and QA Facilitators.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

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

/** A session's QA Facilitators: its own, plus its event's (who run every session in it). */
function facilitatorsFor_(session) {
  const out = (session && session.moderators || []).slice();
  const ev = session && session.eventId ? getEvent_(session.eventId) : null;
  (ev && ev.moderators || []).forEach(function (e) { if (out.indexOf(e) === -1) out.push(e); });
  return out;
}

function canModerate_(session, email) {
  if (isAdmin_(email)) return true;
  return onRoster_('MODERATORS', email) && facilitatorsFor_(session).indexOf(email) !== -1;
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

/** requireSession_ for changes to the queue, which an ended session no longer takes. */
function requireOpenSession_(sid) {
  const session = requireSession_(sid);
  if (session.status === 'ended') throw new Error('This session has ended.');
  return session;
}

function adminEmails_() {
  const list = [ownerEmail_()];
  roster_('ADMINS').forEach(function (e) { if (list.indexOf(e) === -1) list.push(e); });
  return list.filter(Boolean);
}
