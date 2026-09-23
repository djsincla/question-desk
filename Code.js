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
  version: '2.28.0',
  repo: 'https://github.com/djsincla/question-desk'
};

const CONFIG = {
  sheetName: 'Questions',
  topicSheetName: 'Topics',
  assetSheetName: 'Assets',
  archiveSheetName: 'Archive',
  auditSheetName: 'Activity log',
  auditMaxRows: 20000,            // oldest entries are trimmed past this
  archiveAfterDays: 30,           // ended sessions move out of Script Properties after this
  model: 'gemini-3.5-flash',      // gemini-3.1-flash-lite is cheaper if cost matters
  moderatorLanguage: 'English',   // topic labels, translations and merged questions are written in this
  // Languages participants read topic labels and "Now answering" in. Codes match Ask.html.
  // Every language the participant page and room screen can show. An event picks up to
  // maxLanguages of these (English always included); others use the site default.
  languages: {
    en: { name: 'English', native: 'English' },
    ko: { name: 'Korean', native: '한국어' },
    es: { name: 'Spanish', native: 'Español' },
    zh: { name: 'Chinese (Simplified)', native: '中文' },
    vi: { name: 'Vietnamese', native: 'Tiếng Việt' },
    tl: { name: 'Tagalog', native: 'Tagalog' },
    hy: { name: 'Armenian', native: 'Հայերեն' }
  },
  defaultLanguages: ['en', 'ko', 'es'],
  maxLanguages: 4,
  // Languages the app itself is read in: the queue, Admin, the coordinator portal, emails and
  // the room screen footer. Separate from languages above, whose names are compared as values.
  appLanguages: {
    en: { name: 'English', native: 'English' },
    es: { name: 'Spanish', native: 'Español' }
  },
  defaultMaxLength: 300,          // per session, admin can change
  maxLengthCeiling: 1024,         // no session may allow more than this
  cooldownSeconds: 300,           // default wait between questions per phone; each session can change it
  cooldownCeiling: 3600,          // longest wait a session may set
  roomQuestionsMax: 6,            // questions listed on the room screen when a session turns that on
  roomLimitPerMinute: 120,        // per session intake cap: a full room at once (100 tested), spam still groups
  meTooLimitPerMinute: 300,       // per session Me too taps (a full room tapping at once fits)
  entryTokenSeconds: 150,         // how often an in-room QR rotates
  deviceTokenSeconds: 21600,      // 6h — CacheService maximum
  clusterBatchSize: 25,
  reviewMaxQuestions: 400,        // questions sent to Gemini for an event review
  maxPrepared: 100,               // prepared questions per session
  maxImportRows: 200,             // sessions per CSV import
  boardCacheSeconds: 30,          // the queue's board; every change clears it, so this only bounds staleness
  topicCacheSeconds: 5,           // participant topic lists; a full room polls this (phones every 15 s)
  logoMaxChars: 60000,            // base64 data URL; pages load on weak venue wifi
  maxRecipients: 50,
  alertAfterFailures: 3,          // consecutive failed grouping runs before admins are emailed
  alertRepeatHours: 6,
  loadTestMinutes: 60
};

const COLS = {
  id: 1, submitted: 2, device: 3, text: 4,
  status: 5, topic: 6, lang: 7, translation: 8, session: 9,
  grouping: 10,       // 'ungrouped' when a facilitator took it out of a topic: automatic grouping leaves it
  translations: 11,   // JSON { ko: …, es: … } in the session's languages (from grouping, or prepared-question translation)
  logistics: 12       // '' | 'yes' (about running the event) | 'sorted' (a coordinator has dealt with it)
};

const HEADERS = ['ID', 'Submitted', 'Device', 'Question', 'Status', 'Topic',
                 'Language', 'Translation', 'Session', 'Grouping', 'Translations', 'Logistics'];

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
    return page_('Admin.html', t_('page.admin'), {}, null);
  }

  // Printable QR sheets for an event's shareable-link sessions (admins; opened in a new tab to print).
  if (view === 'qrsheet') {
    if (!isAdmin_()) return notice_('denied');
    const ev = getEvent_(p.e);
    if (!ev) return notice_('pick', 'admin');
    const sessions = allSessions_().filter(function (s) { return s.eventId === ev.id && !s.loadTest && s.status !== 'ended'; });
    return page_('Sheet.html', ev.name + ' — QR sheets', {
      eventName: ev.name,
      languages: ev.languages && ev.languages.length ? ev.languages : siteLanguages_(),
      sessions: sessions.map(function (s) {
        return { name: s.name, heading: s.heading || '', url: s.access === 'link' ? sessionLinks_(s).participant : '' };
      })
    }, { eventId: ev.id });
  }

  // The room screen needs no sign-in: anyone with its link can show it, whatever Google
  // account the browser uses. The link carries its own key (r=), separate from the session
  // id that every participant link and QR code contains, so a forwarded participant link
  // can't be turned into a room screen showing live codes.
  if (view === 'present') {
    const screen = getSession_(sid);
    if (screen && (screenKeyValid_(screen, p.r) || canModerate_(screen, currentEmail_()))) {
      // layout=qr is the compact QR-only view used by the PowerPoint add-in (docs/addin).
      return page_('Present.html', screen.name, {
        sid: screen.id, key: screenKeyFor_(screen), theme: screen.theme, layout: p.layout === 'qr' ? 'qr' : 'full',
        languages: languagesFor_(screen), version: APP.version
      }, screen);
    }
    if (screen) return notice_('oldScreenLink');
    if (!currentEmail_()) return notice_('noSession');
    return notice_('pick', view);
  }

  // Panelist view: the question being answered, large, for a tablet on the panel table.
  // Same key as the room screen: it shows nothing the room screen doesn't.
  if (view === 'panel') {
    const panel = getSession_(sid);
    if (panel && (screenKeyValid_(panel, p.r) || canModerate_(panel, currentEmail_()))) {
      return page_('Panel.html', panel.name + ' — panel', { sid: panel.id, key: screenKeyFor_(panel), theme: panel.theme, version: APP.version }, panel);
    }
    if (panel) return notice_('oldScreenLink');
    if (!currentEmail_()) return notice_('noSession');
    return notice_('pick', view);
  }

  // The Event Coordinator portal: one link per event, and a sign-in — it shows what people
  // actually typed, so it is not a link to hand around.
  if (view === 'coordinator') {
    const email = currentEmail_();
    if (!email) return notice_('denied');
    const ev = getEvent_(p.e);
    if (!ev || !canCoordinate_(ev, email)) {
      const mine = eventsForCoordinator_(email);
      if (!mine.length) return notice_('denied');
      if (!ev) return notice_('pickEvent');
      return notice_('denied');
    }
    return page_('Coordinator.html', t_('page.coordinator', { event: ev.name }), {
      eid: ev.id, board: getCoordinatorBoard(ev.id)
    }, { eventId: ev.id });
  }

  if (view === 'moderate') {
    const email = currentEmail_();
    if (!email || !(isAdmin_(email) || onRoster_('MODERATORS', email))) return notice_('denied');
    const session = getSession_(sid);
    if (!session) return notice_('pick', view);
    if (!canModerate_(session, email)) return notice_('denied');
    return page_('Moderate.html', 'QA - ' + session.name, { sid: session.id }, session);
  }

  if (view === 'ask' && !p.s) return home_();

  const session = getSession_(sid);
  return page_('Ask.html', t_('page.ask'), {
    sid: session ? session.id : '',
    credential: String(p.t || p.k || '').slice(0, 64),
    languages: languageList_(session)
  }, session);
}

/** Renders a page with server data injected as a JSON literal (see BOOT in each file). */
function page_(file, title, boot, session) {
  const template = HtmlService.createTemplateFromFile(file);
  // Every page's styles and shared script live in Styles.html and Scripts.html; inlined so
  // pages stay one request.
  template.styles = stylesFor_(file);
  template.scripts = scriptsFor_(file);
  boot.brand = brand_(session);
  if (UI_TEXT_FOR[file]) boot.text = UI_TEXT[UI_TEXT_FOR[file]];
  if (APP_TEXT_FOR[file]) {
    // Nobody is signed in at a venue laptop, so the room screen and the panelist view read the
    // session's language; every other page reads the language of the person in front of it.
    const room = file === 'Present.html' || file === 'Panel.html';
    boot.lang = room ? roomLanguage_(session) : appLanguage_();
    boot.words = wordsFor_(boot.lang);
  }
  template.boot = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
  const framable = ['Ask.html', 'Present.html', 'Panel.html', 'Denied.html'].indexOf(file) !== -1;
  const output = template.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  // Guest pages are framed by the guest page and the PowerPoint add-in. Admin and the queue
  // keep Google's default, so another site can't frame them to trick a signed-in click.
  if (framable) output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  if (boot.brand.faviconUrl) {
    // Google rejects some icon URLs; a bad icon must never take the page down.
    try { output.setFaviconUrl(boot.brand.faviconUrl); } catch (err) { console.error('Favicon: ' + err); }
  }
  return output;
}

/**
 * The <style> block for one page: the sections of Styles.html marked "@pages" with this page's
 * name (the shared section, then the page's own). A phone never downloads the Admin styles.
 */
function stylesFor_(file) {
  return '<style>\n' + sectionsFor_('Styles', 'style', file) + '</style>';
}

/** The shared <script> for one page, from Scripts.html's sections for it ('' if none). */
function scriptsFor_(file) {
  const js = sectionsFor_('Scripts', 'script', file);
  return js ? '<script>\n' + js + '</script>' : '';
}

/**
 * The sections of Styles.html or Scripts.html for one page, in file order: each section is a
 * <style> or <script> element whose data-pages attribute lists the pages it's for. (Not
 * comment markers: Apps Script strips comments when it reads a file, which silently left
 * every page unstyled in 2.21.1 and 2.22.0.)
 */
function sectionsFor_(source, tag, file) {
  const page = String(file).replace(/\.html$/, '');
  const text = HtmlService.createHtmlOutputFromFile(source).getContent();
  const re = new RegExp('<' + tag + '\\s+data-pages\\s*=\\s*["\']([A-Za-z ]+)["\']\\s*>([\\s\\S]*?)</' + tag + '>', 'g');
  let out = '';
  let m;
  while ((m = re.exec(text))) {
    if (m[1].split(/\s+/).indexOf(page) !== -1) out += m[2].replace(/^\n/, '');
  }
  return out;
}

/** Splash page at the bare app address. Staff see their live sessions; everyone else sees how to join. */
function home_() {
  const email = currentEmail_();
  const admin = isAdmin_(email);
  const staff = admin || onRoster_('MODERATORS', email);
  const base = baseUrl_();
  const orgName = brand_(null).orgName;
  return page_('Home.html', orgName ? orgName + ' — Question Desk' : 'Question Desk', {
    languages: siteLanguages_(),
    version: APP.version,   // public anyway (GitHub releases); lets the live check confirm the deploy
    signedIn: !!email,
    staff: staff,
    adminUrl: admin ? base + '?view=admin' : '',
    domain: domainOf_(ownerEmail_()),
    signInUrl: 'https://accounts.google.com/AccountChooser?continue=' + encodeURIComponent(base),
    sessions: staff ? sessionsFor_(email)
      .filter(function (s) { return s.status !== 'ended' && !s.loadTest; })
      .map(function (s) {
        const links = sessionLinks_(s);
        return { name: s.name, eventName: eventName_(s), status: s.status, present: links.present, moderate: links.moderate };
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
        const ev = eventName_(s);
        return {
          label: ev ? ev + ' — ' + s.name : s.name,
          note: t_(s.status === 'active' ? 'notice.pick.active' : 'notice.pick.inactive'),
          href: view === 'present' ? sessionLinks_(s).present : base + '?view=' + view + '&s=' + s.id
        };
      });
    return page_('Denied.html', t_('notice.pick.title'), {
      heading: t_('notice.pick.title'),
      body: t_(links.length ? 'notice.pick.body' : 'notice.pick.none'),
      links: links
    }, null);
  }
  if (mode === 'pickEvent') {
    const base = baseUrl_();
    const links = eventsForCoordinator_(currentEmail_()).map(function (ev) {
      return { label: ev.name, note: '', href: base + '?view=coordinator&e=' + ev.id };
    });
    return page_('Denied.html', t_('notice.pickEvent.title'), {
      heading: t_('notice.pickEvent.title'),
      body: t_(links.length ? 'notice.pickEvent.body' : 'notice.pickEvent.none'),
      links: links
    }, null);
  }
  if (mode === 'oldScreenLink') {
    return page_('Denied.html', t_('notice.oldScreenLink.tab'), {
      heading: t_('notice.oldScreenLink.title'),
      body: t_('notice.oldScreenLink.body'),
      links: []
    }, null);
  }
  if (mode === 'noSession') {
    return page_('Denied.html', t_('notice.noSession.tab'), {
      heading: t_('notice.noSession.title'),
      body: t_('notice.noSession.body'),
      links: []
    }, null);
  }
  return page_('Denied.html', t_('notice.denied.tab'), {
    heading: t_('notice.denied.title'),
    body: t_('notice.denied.body'),
    links: []
  }, null);
}
