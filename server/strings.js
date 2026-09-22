/**
 * Question Desk server code: every word staff and the stage read, in each app language.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 *
 * Two catalogs, split by who is reading, because they ship differently:
 *   UI_TEXT (text.js)  the audience. Every language goes to the page; the phone picks, because
 *                      there is no reader to ask.
 *   APP_TEXT (here)    staff, and the people on stage. The server knows who is reading, so it
 *                      resolves one language and sends only that, as BOOT.words.
 *
 * Keys are flat and dotted, and name a place, not a phrase: two screens that happen to say the
 * same English word still get their own key, because one Spanish word rarely fits both.
 * Languages are CONFIG.appLanguages, which is deliberately not CONFIG.languages — those names
 * are compared as values (participants.js, summaries.js) and must not grow entries.
 */

// ---------------------------------------------------------------- staff-facing text

const APP_TEXT = {
  'shared.dialog.ok': { en: 'OK' },
  'shared.dialog.typePrompt': { en: 'To confirm, type ' },
  'shared.failed': { en: 'Something went wrong.' },

  'home.staff.heading': { en: 'For staff' },
  'home.staff.none': { en: 'No open sessions assigned to you.' },
  'home.staff.admin': { en: 'Open the admin page' },
  'home.staff.signIn': { en: 'QA Facilitators and administrators: {link} with your {domain} account.' },
  'home.staff.signInLink': { en: 'sign in' },
  'home.session.active': { en: 'Active' },
  'home.session.inactive': { en: 'Not active' },
  'home.link.present': { en: 'Room screen' },
  'home.link.queue': { en: 'Queue' },

  'mod.title': { en: 'Question queue' },
  'mod.pageTitle': { en: 'QA - {name}' },
  'mod.pageTitleRoom': { en: 'QA - {name} ({room})' },
  'mod.switchSession': { en: 'Switch session' },
  'mod.optionEnded': { en: ' (ended)' },
  'mod.optionInactive': { en: ' (not active)' },
  'mod.loading': { en: 'Loading…' },
  'mod.roomScreen': { en: 'Room screen' },
  'mod.panelLink': { en: 'Panelist view' },
  'mod.panelLinkTitle': { en: 'The question being answered, large, for the panel table' },
  'mod.shortcuts': { en: 'Shortcuts' },
  'mod.shortcutsTitle': { en: 'Keyboard shortcuts (press ?)' },
  'mod.admin': { en: 'Admin' },
  'mod.endedNotice': { en: 'This session has ended. The queue is read-only.' },
  'mod.selectedRegion': { en: 'Selected questions' },
  'mod.selGroup': { en: 'Group as…' },
  'mod.selUngroup': { en: 'Ungroup' },
  'mod.selAnswered': { en: 'Answered' },
  'mod.selDismiss': { en: 'Dismiss' },
  'mod.selClear': { en: 'Clear' },
  'mod.selCount.one': { en: '{n} question selected' },
  'mod.selCount.other': { en: '{n} questions selected' },
  'mod.toggleTitle': { en: 'Click to pause or resume new questions' },
  'mod.accepting': { en: 'Accepting questions' },
  'mod.paused': { en: 'Paused — not accepting questions' },
  'mod.groupNow': { en: 'Group now' },
  'mod.groupNowTitle': { en: 'Group and translate waiting questions now, even when automatic grouping is off' },
  'mod.grouping': { en: 'Grouping…' },
  'mod.groupingFailed': { en: 'Grouping failed — retry' },
  'mod.autoGroup': { en: 'Group automatically' },
  'mod.autoGroupTitle': { en: 'Every minute, Gemini groups new questions into topics. Off: questions are still translated, and you group them yourself.' },
  'mod.autoShow': { en: 'Show on phones when answering' },
  'mod.autoShowTitle': { en: 'Answer now also shows the topic on participants\' phones' },
  'mod.roomQuestions': { en: 'List on the room screen' },
  'mod.roomQuestionsTitle': { en: 'The room screen lists what\'s on participants\' phones, most Me too first' },
  'mod.originals': { en: 'Show original wording' },
  'mod.prepared': { en: 'Prepared questions' },
  'mod.dismissedBox': { en: 'Dismissed' },
  'mod.empty': { en: 'Waiting for the first question.' },
  'mod.groupDialogTitle': { en: 'Group questions' },
  'mod.groupHint': { en: 'Type a new topic, or pick one that exists to add these questions to it.' },
  'mod.topicName': { en: 'Topic name' },
  'mod.groupOk': { en: 'Group' },
  'mod.cancel': { en: 'Cancel' },
  'mod.pillActive': { en: 'Active' },
  'mod.pillEnded': { en: 'Ended' },
  'mod.pillInactive': { en: 'Not active' },
  'mod.tally': { en: '{questions} across {topics}' },
  'mod.tallyQuestions.one': { en: '{n} question' },
  'mod.tallyQuestions.other': { en: '{n} questions' },
  'mod.tallyTopics.one': { en: '{n} topic' },
  'mod.tallyTopics.other': { en: '{n} topics' },
  'mod.saveFailed': { en: 'That change didn\'t save{detail} — reloaded the queue' },
  'mod.groupingDown': { en: 'Automatic grouping isn\'t working right now, so new questions aren\'t grouped or translated. Until it recovers, they\'re sorted below by a word they share. ({detail})' },
  'mod.looseMentions': { en: 'Not yet grouped · mentions “{word}”' },
  'mod.looseOther': { en: 'Not yet grouped · other questions' },
  'mod.notYetGrouped': { en: 'Not yet grouped' },
  'mod.questionsGroup': { en: 'Questions' },
  'mod.logistics': { en: 'About running the event: it is with the Event Coordinators as well as you.' },
  'mod.logisticsSorted': { en: 'About running the event. The Event Coordinators have sorted it.' },
  'mod.addToQueue': { en: 'Add to queue' },
  'mod.restore': { en: 'Restore' },
  'mod.readOut': { en: 'Read out' },
  'mod.save': { en: 'Save' },
  'mod.edit': { en: 'Edit' },
  'mod.remove': { en: 'Remove' },
  'mod.writeItYourself': { en: 'Write it yourself' },
  'mod.mergeBadAnswer': { en: 'Gemini\'s answer couldn\'t be used. Try again.' },
  'mod.mergeUnreachable': { en: 'Couldn\'t reach Question Desk ({detail}). Try again.' },
  'mod.connectionProblem': { en: 'connection problem' },
  'mod.mergeFailed': { en: 'Couldn\'t write it: {why}' },
  'mod.translations': { en: 'Translations · {names}' },
  'mod.topicCount.one': { en: '{n} question' },
  'mod.topicCount.other': { en: '{n} questions' },
  'mod.topicCountDone.one': { en: '{n} question · all answered' },
  'mod.topicCountDone.other': { en: '{n} questions · all answered' },
  'mod.meToo': { en: ' · +{n} me too' },
  'mod.answeringNow': { en: 'Answering now' },
  'mod.answeringNowTimer': { en: 'Answering now · {time}' },
  'mod.answerNow': { en: 'Answer now' },
  'mod.stopAnswering': { en: 'Stop answering' },
  'mod.answerNowTitle': { en: 'Put this topic on the room screen and participants\' phones as the one being answered' },
  'mod.stopAnsweringTitle': { en: 'Take this topic off the room screen and participants\' phones' },
  'mod.answerNowQuestionTitle': { en: 'Show this question on the room screen and phones as the one being answered' },
  'mod.onPhones': { en: 'On phones ✓' },
  'mod.showOnPhones': { en: 'Show on phones' },
  'mod.onPhonesTitle': { en: 'Participants can see this topic and tap Me too. Click to hide it from phones.' },
  'mod.showOnPhonesTitle': { en: 'Let participants see this topic label and tap Me too' },
  'mod.phonesOn': { en: 'Phones ✓' },
  'mod.phones': { en: 'Phones' },
  'mod.phonesOnTitle': { en: 'Participants can see this question and tap Me too. Click to hide it from phones.' },
  'mod.phonesTitle': { en: 'Let participants see this question (translated into their language) and tap Me too' },
  'mod.dismissAll.one': { en: 'Dismiss all {n} question' },
  'mod.dismissAll.other': { en: 'Dismiss all {n} questions' },
  'mod.dismissTopicTitle': { en: 'Dismiss this topic?' },
  'mod.dismissTopicBody.one': { en: 'All {n} question under "{topic}" move to Dismissed at the bottom of the page and come off participants\' phones. You can restore them.' },
  'mod.dismissTopicBody.other': { en: 'All {n} questions under "{topic}" move to Dismissed at the bottom of the page and come off participants\' phones. You can restore them.' },
  'mod.dismissAllOk': { en: 'Dismiss all' },
  'mod.answeredTag': { en: '✓ Answered' },
  'mod.answered': { en: 'Answered' },
  'mod.reopen': { en: 'Reopen' },
  'mod.answeredTitle': { en: 'Mark this question as answered' },
  'mod.reopenTitle': { en: 'Mark as not answered yet' },
  'mod.dismiss': { en: 'Dismiss' },
  'mod.dismissTitle': { en: 'Move to Dismissed at the bottom of the page' },
  'mod.lostConnection': { en: 'Lost connection — retrying' },
  'mod.notUpdating': { en: 'Not updating — check the connection' },
  'mod.updated': { en: 'Updated {at}' },
  'mod.keysTitle': { en: 'Keyboard shortcuts' },
  'mod.keysOk': { en: 'Got it' },
  'mod.keys.next': { en: 'Next question' },
  'mod.keys.nextPress': { en: 'J or ↓' },
  'mod.keys.prev': { en: 'Previous question' },
  'mod.keys.prevPress': { en: 'K or ↑' },
  'mod.keys.tick': { en: 'Tick the question (then Group as…, Ungroup, Answered or Dismiss)' },
  'mod.keys.answered': { en: 'Answered (or Reopen)' },
  'mod.keys.dismiss': { en: 'Dismiss' },
  'mod.keys.live': { en: 'Answer now / Stop answering for its topic' },
  'mod.keys.phones': { en: 'Show on or hide from phones (a question not in a topic, or else its topic)' },
  'mod.keys.merge': { en: 'Write (or rewrite) one question to read out for the topic' },
  'mod.keys.group': { en: 'Group now' },
  'mod.keys.originals': { en: 'Show original wording' },
  'mod.keys.clear': { en: 'Clear the selection' },
  'mod.keys.list': { en: 'This list' },

  'mod.eventTeam': { en: 'Event team' },
  'mod.eventTeamDone': { en: 'Event team ✓' },
  'mod.alsoShownAnswerNow': { en: 'With Answer now, phones and the room screen show' },
  'mod.readOutFor': { en: 'Question to read out for {topic}' },
  'mod.mergeBusy': { en: 'Gemini is writing one question for this topic. This can take up to half a minute.' },
  'mod.rewriteWithGemini': { en: 'Rewrite with Gemini' },
  'mod.writeReadOut': { en: 'Write one question to read out' },
  'mod.mergeHint.one': { en: 'Gemini combines this {n} question into one. You can edit it.' },
  'mod.mergeHint.other': { en: 'Gemini combines these {n} questions into one. You can edit it.' },
  'mod.trTopicOnPhones': { en: 'Topic on phones' },
  'mod.trTopicIfShown': { en: 'Topic, if shown on phones' },
  'mod.trReadOut': { en: 'Read-out question' },
  'mod.moreActions': { en: 'More actions for {topic}' },
  'mod.groupingLate': { en: 'Grouping runs every minute. Questions still waiting? Press Group now, or run the health check on the Admin page.' },
  'mod.selectQuestion': { en: 'Select this question' },

  'panel.nowAnswering': { en: 'Now answering' },
  'panel.timerTitle': { en: 'Time on this question' },
  'panel.waiting': { en: 'Waiting for the facilitator to choose a question.' },
  'panel.ended': { en: 'This session has ended. Thank you.' },
  'panel.notStarted': { en: 'This session hasn\'t started yet.' },
  'panel.live': { en: 'Updates automatically' },
  'panel.stale': { en: 'Not updating — check the connection' },

  'present.waitingToStart': { en: 'Waiting for this session to start' },
  'present.codeRefreshes': { en: 'Code refreshes automatically' },
  'present.paused': { en: 'Questions are paused' },
  'present.lostConnection': { en: 'Lost connection — retrying' },
  'present.stale': { en: 'Not updating — check the internet connection. This code may have expired.' },
  'present.codeUpdated': { en: ' · code updated {at}' },

  'sheet.pageTitle': { en: '{event} — QR sheets' },
  'sheet.print': { en: 'Print' },
  'sheet.download': { en: 'Download QR images' },
  'sheet.downloadFallback': { en: 'Save each image below' },
  'sheet.intro.one': { en: '{n} page for {event}, one per shareable-link session. Print on letter or A4.' },
  'sheet.intro.other': { en: '{n} pages for {event}, one per shareable-link session. Print on letter or A4.' },
  'sheet.nothing': { en: 'No sessions in {event} use a shareable link, so there is nothing to print.' },
  'sheet.qr': { en: 'QR code' },
  'sheet.qrFor': { en: 'QR code for {name}' },
  'sheet.skipped': { en: 'Not printed (in-room sessions join by the changing code on the room screen): {names}.' },
  'sheet.saveByHand': { en: 'Right-click (or press and hold) each image to save it.' },

  'coord.title': { en: 'Event logistics' },
  'coord.pageTitle': { en: '{event} — event logistics' },
  'coord.loading': { en: 'Loading…' },
  'coord.adminLink': { en: 'Admin' },
  'coord.waiting': { en: '{n} waiting' },
  'coord.allSorted': { en: 'All sorted' },
  'coord.tally.one': { en: '{n} question about running the event' },
  'coord.tally.other': { en: '{n} questions about running the event' },
  'coord.lead': { en: 'Questions the audience asked about the event itself — rooms, timing, access, food, signage. They are also in each session’s queue, so a facilitator can answer from the stage; tick one here when it has been dealt with.' },
  'coord.answered': { en: 'Answered in the session' },
  'coord.putBack': { en: 'Put back' },
  'coord.sorted': { en: 'Sorted' },
  'coord.empty': { en: 'Nothing yet. Questions about rooms, timing, access or anything else about running the event will appear here as they are asked.' }
};

/** Pages that read BOOT.words. Ask.html is not one: participants get BOOT.text instead. */
const APP_TEXT_FOR = {
  'Admin.html': true,
  'Coordinator.html': true,
  'Home.html': true,
  'Moderate.html': true,
  'Panel.html': true,
  'Present.html': true,
  'Sheet.html': true
};

/** Fills {name} placeholders. Anything the catalog has no value for is left as it stands. */
function format_(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, function (whole, name) {
    return vars[name] === undefined || vars[name] === null ? whole : String(vars[name]);
  });
}

/**
 * Which plural form a count takes. English and Spanish agree (one / other); a language that
 * needs more forms adds itself here rather than to 27 call sites.
 */
function plural_(lang, n) {
  return Number(n) === 1 ? 'one' : 'other';
}

/** An app language code we actually have, or English. */
function appLanguageCode_(code) {
  return code && CONFIG.appLanguages[code] ? code : 'en';
}

/** The whole catalog in one language, English wherever that language has no wording yet. */
function wordsFor_(lang) {
  const code = appLanguageCode_(lang);
  const out = {};
  Object.keys(APP_TEXT).forEach(function (key) {
    out[key] = APP_TEXT[key][code] || APP_TEXT[key].en;
  });
  return out;
}

/** One phrase, for the server's own use (errors, emails). */
function t_(key, vars, lang) {
  const entry = APP_TEXT[key];
  if (!entry) throw new Error('Unknown phrase ' + key + '.');
  return format_(entry[appLanguageCode_(lang)] || entry.en, vars);
}

/** The language one person reads the app in. Set per person on the People tab. */
function appLanguage_(email) {
  if (email === undefined) email = currentEmail_();
  const saved = personLanguages_()[String(email || '').toLowerCase()];
  return appLanguageCode_(saved || siteLanguage_());
}

/** Everyone's chosen language, by address. */
function personLanguages_() {
  try {
    return JSON.parse(props_().getProperty('PEOPLE_LANG') || '{}') || {};
  } catch (err) {
    return {};
  }
}

/** The site's own language: what a room screen and anyone with no choice of their own reads. */
function siteLanguage_() {
  return appLanguageCode_(props_().getProperty('APP_LANGUAGE'));
}

/**
 * The language a room screen, slide and panelist view speak. Nobody is signed in at a venue
 * laptop, so it follows the session, then its event, then the site.
 */
function roomLanguage_(session) {
  if (session && session.roomLanguage) return appLanguageCode_(session.roomLanguage);
  const ev = session && session.eventId ? getEvent_(session.eventId) : null;
  if (ev && ev.roomLanguage) return appLanguageCode_(ev.roomLanguage);
  return siteLanguage_();
}
