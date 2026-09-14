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
  version: '2.22.0',
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
  defaultMaxLength: 300,          // per session, admin can change
  maxLengthCeiling: 1024,         // no session may allow more than this
  cooldownSeconds: 300,           // default wait between questions per phone; each session can change it
  cooldownCeiling: 3600,          // longest wait a session may set
  roomLimitPerMinute: 120,        // per session intake cap: a full room at once (100 tested), spam still groups
  meTooLimitPerMinute: 300,       // per session Me too taps (a full room tapping at once fits)
  entryTokenSeconds: 150,         // how often an in-room QR rotates
  deviceTokenSeconds: 21600,      // 6h — CacheService maximum
  clusterBatchSize: 25,
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
  translations: 11    // JSON { ko: …, es: … } in the session's languages (prepared questions)
};

const HEADERS = ['ID', 'Submitted', 'Device', 'Question', 'Status', 'Topic',
                 'Language', 'Translation', 'Session', 'Grouping', 'Translations'];

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

/** The sections of Styles.html or Scripts.html marked "@pages … <page> …", in file order. */
function sectionsFor_(source, tag, file) {
  const page = String(file).replace(/\.html$/, '');
  const text = HtmlService.createHtmlOutputFromFile(source).getContent();
  const inner = text.slice(text.indexOf('<' + tag + '>') + tag.length + 2, text.lastIndexOf('</' + tag + '>'));
  const parts = inner.split(/[ \t]*\/\* =+ @pages ([A-Za-z ]+) \*\/\n/);
  let out = '';
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i].split(' ').indexOf(page) !== -1) out += parts[i + 1];
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
  if (mode === 'oldScreenLink') {
    return page_('Denied.html', 'Room screen link out of date', {
      heading: 'This room screen link is out of date',
      body: 'Room screen and PowerPoint slide links changed. Ask whoever runs the session to copy the new one from the Admin page (Sessions → Links). To ask a question, scan the code on the screen in the room.',
      links: []
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
