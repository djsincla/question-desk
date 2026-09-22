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
