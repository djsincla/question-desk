# Question Desk

Anonymous audience Q&A for a small nonprofit, built as a Google Apps Script web app
with Gemini doing topic clustering and translation. Runs entirely inside the org's
Workspace account. See SETUP.md for install and deployment.

## Files

- `Code.js` — all server logic (clasp uploads it as `Code.gs`); `APP.version` is the release
- `Home.html` — landing page at the bare app address; staff links when signed in
- `Ask.html` — participant page, localized en/ko/es; Me too topics and Now answering
- `Present.html` — room screen: QR, Now answering banner, brand colors, light/dark
- `Panel.html` — panelist view (`view=panel`, room screen key): the question being answered,
  large, with a timer from `nowAnswering.at`
- `Moderate.html` — facilitator queue for one session, grouped by topic, Now answering
- `Admin.html` — sessions (schedule, per-session branding), people, branding, health, load test
- `Denied.html` — not-allowed page, also the session picker
- `Styles.html` — shared design tokens and components (one `<style>` block), inlined into
  every page except Present.html by `page_()` through `<?!= styles ?>`
- `appsscript.json` — manifest; web app set to execute as owner, anonymous access
- `.claspignore` — allowlist of what `clasp push` uploads; add new pages here
- `tests/` — Node test suite that runs `Code.js` against fake Apps Script services
- `scripts/ship.sh` — secret scan, tests, push, version, redeploy, tag, GitHub release
- `scripts/loadtest.js` — simulates a full room against a running load test
- `scripts/check-secrets.js` — blocks keys, IDs and real email addresses (hook and CI)
- `CHANGELOG.md` — release notes; `ship.sh` publishes the section for `APP.version`
- `docs/join/` — the guest page: frames guest pages from another site so Safari/Firefox send
  Google no cookies (Google's multi-account "unable to open the file"). `guestLink_()` builds
  `<guest page>?d=<deployment>&<query>`. Sessions choose it per link
  (`guestPage: {room, slide, panel, url}`, read via `guestChoice_()`, which also accepts the
  pre-2.4.4 `{mode:'wrapper'}` and pre-2.18 `{room, slide}`, where the panelist view followed
  room): room = room screen link + its QR; slide = the slide link itself + the slide's QR
  (from `getRoomScreen(sid, 'qr')`); panel = panelist view link. Each tick must change its own
  link — the 2.4.4–2.17 slide tick changed only the QR, which looked like it did nothing. `join-url.js` only frames script.google.com guest
  pages. Tested in-browser that data calls from other sites (ContentService doPost) are slow
  and fail ~half the time on Google's side — don't build guest pages on fetch(); frame instead.
- `docs/addin/install/` — add-in installers (Mac `.sh`/`.command`, Windows `.ps1`/`.cmd`) and
  the download zips built by `scripts/build-addin-installers.sh` (tests fail if the zips are
  stale). Windows registers `HKCU\Software\Microsoft\Office\16.0\Wef\Developer\<add-in id>`;
  Mac writes `wef/<add-in id>.manifest.xml`. CI runs both for real.
- `docs/addin/` — *Question Desk QR* PowerPoint content add-in, served by GitHub Pages
  (`main` branch, `/docs`). `manifest.xml` `<Version>` tracks `APP.version`. The page only
  frames addresses from `room-url.js` (public `/macros/s/` form, or the session's guest page
  when the slide link is a guest page link; always `&layout=qr` since 2.20). Room screens and
  panelist views `postMessage` `{questionDesk: 'ok'|'outdated'|'refused'}` to `window.top` on
  each update; the add-in (and a top-level guest page) accepts them only from
  `RoomUrl.fromGoogle()` origins, reloads a frame silent for 3 minutes or reporting
  `outdated` (once per 10 minutes), and falls back from a guest page to `RoomUrl.direct()`
  when nothing reports within 20 s — many sites (autismla.org) send `X-Frame-Options`.
  Since 2.21 any other https page (`RoomUrl.webPage()`) can be shown too: framed with
  `sandbox` (`PAGE_SANDBOX`, no top navigation or modals), no fallback or reloads.

Pages get server data through a single template scriptlet, `var BOOT = <?!= boot ?>;`,
filled by `page_()` with `<` and U+2028/2029 escaped. The only other scriptlet is
`<?!= styles ?>` in the head (the trusted Styles.html, before the page's own styles, which
may override it). Do not add other scriptlets, and
never read `window.location` for parameters — pages run in a sandboxed iframe whose URL
does not carry the query string. That exact bug shipped once (v2): every QR scan failed.

## Sessions and roles

- Events live in Script Properties as `EVENT_<8 hex>` (`{id, name, order, brand, hasLogo}`);
  a session's optional `eventId` points to one. `brand_(session)` resolves site → event →
  session; event logos are `event:<id>` in the Assets sheet. Deleting an event keeps its
  sessions (their `eventId` is removed). `saveSession` leaves `eventId` alone when the input
  omits it; `''` removes it.
- Activity log: `audit_(action, sessionOrEvent, details)` appends to the `Activity log` sheet
  after every staff action (never participants). Who is `currentEmail_()`, or
  `EXEC_.auditWho` ('Schedule (automatic)' inside `runSchedule_`); `EXEC_.auditVia` tags
  CSV-imported changes. It never throws. New staff actions must call it; `getActivity()`
  reads it for the Admin Activity tab; `trimAudit_()` keeps `CONFIG.auditMaxRows`.
- Sessions CSV: columns are `SESSION_CSV` (header text → input key). `importSessionsCsv(text,
  {duplicates}, dryRun)` validates each row with `saveSessionAs_(input, me, true)` (the same
  code as the form), so check and import agree. The duplicate key is `sessionKey_`: name
  (case/space-insensitive) plus start and end to the minute, or name alone when neither time
  is set. Updates start from `sessionInput_(existing)`, so missing columns change nothing.
  New sessions keep the file's order. Times use `Utilities.parseDate/formatDate` in the
  script time zone (the harness fakes both with real time-zone math).
- A session's QA Facilitators are `facilitatorsFor_(session)`: its own plus its event's
  `moderators`. Use it (not `session.moderators`) for access, summaries and emails.
- **Writes to Sheets are batched; never append question rows in parallel.** A submission
  saves `Q_<sid>_<id>` in Script Properties (no lock: unique key) and returns;
  `flushInbox_(sid?)` writes buffered questions to the sheet in one `setValues` under the
  lock, oldest first, skipping ids already there. It runs on every `getBoard`, in
  `adminState`, each minute, and before grouping, summaries, ending, archiving and staff
  question actions. Parallel `appendRow` lost 25 of 40 questions in a load test (2.14.1–2.15.0);
  a harness test fails if a question row is ever written without the lock. Activity log
  entries are buffered the same way (`A_<time>_<seq>_<rand>`, `flushAudit_()` each minute and
  before reading). Same-value cell updates use `setCells_` (one RangeList call).
- The queue's board is cached per session (`boardData_`, `board:<sid>`, 30 s) — rows, topics,
  merged and prepared questions; votes, session settings and viewer details are always
  fresh. `invalidateTopics_(sid)` clears it with the phone topic cache: call it after any
  change to a session's questions, topics or languages.
- Questions sheet columns 10–11: `Grouping` (`ungrouped` = taken out of a topic by hand;
  automatic grouping skips it unless Group now; before 2.16 a `?` language marked this) and
  `Translations` (JSON in the session's languages). `session.translatePrepared` (default
  on) makes `saveSessionAs_` call `translatePrepared_(sid)`: language, English and
  `translationCodes_(session)` only; `translatePendingPrepared_()` retries from the schedule.
  A single question on Answer now uses its stored translations.
- Grouping by hand: `groupQuestions(sid, ids, topic)` sets the topic (language left blank,
  so the every-minute run still translates it and keeps the topic via `fixedTopic`);
  `ungroupQuestions` clears the topic and sets language to itself or `?` so automatic
  grouping leaves it alone (`sessionRows_` hides `?`). `session.autoGroup === false`:
  Gemini translates but doesn't group. `groupNow` forces grouping (`clusterSession_(sid, true)`).
- Now answering is a topic or one question: `{topic}` or `{question, at}`
  (`setNowAnswering(sid, topic, questionId)`). `setStatus` clears it when the live question,
  or every open question in the live topic, is answered or dismissed. Fully answered topics
  leave phones. `session.autoShowOnPhones` approves a topic for phones on Answer now.
- Operations: `opsSettings_()` (`OPS` property: `retentionMonths`, `weeklyReport`).
  `runMaintenance_()` runs hourly from the schedule: `applyRetention_()` replaces question
  wording, translations, merged questions and quoted log details for sessions (live or
  archived) that ended over N months ago; `weeklyReportDue_()` sends `weeklyReport_()` on
  Mondays after 8 a.m. When grouping fails (`health_().failures >= 2`) or questions wait
  over 3 minutes, `getBoard` adds `looseGroups` from `keywordGroups_()` — display only,
  nothing is written, so Gemini's grouping takes over when it's back.
- Event tools: `eventChecklist(eid)`, `emailEventSummary(eid, to)` (reuses
  `summaryContent_`), `duplicateSession(sid)` / `duplicateEvent(eid)` (via `sessionInput_`,
  schedules cleared, new keys), and `view=qrsheet&e=<event>` → `Sheet.html` (admins only).
- Ended sessions older than `CONFIG.archiveAfterDays` (or archived by an admin) move from
  Script Properties into the `Archive` sheet (session JSON and votes) by `archiveOld_()` on
  the schedule, so the 500KB property store doesn't fill up. `restoreSession()` puts one
  back. Questions stay in the Questions sheet. Sessions still owed a summary aren't archived.
- Sessions live in Script Properties as `SESSION_<8 hex>` JSON (9KB per value).
  Questions carry the session id in column I; merged questions are in the `Topics` sheet.
  Status is `inactive` → `active` ↔ `inactive` → `ended`; ended is final.
- Every per-person/per-room key is scoped by session: room token `TOKEN_<id>`, cache
  keys `dev:<id>:<device>`, `cool:<id>:<device>`, `room:<id>:<minute>`. A device that
  joined one session has nothing in another.
- Access is chosen per session: `room` (rotating 150s QR token, as below) or `link`
  (fixed `linkKey`, emailable, replaceable by an admin). Clustering and cooldown apply
  to both.
- On screen, in dialogs and in emails, moderators are called **QA Facilitators**. Code,
  property names (`MODERATORS`), function names and the `moderator` role value keep the
  old word so stored data doesn't change; keep new user-facing text on the new term.
- Prepared questions are rows with status and device `prepared`. `sessionRows_()` hides
  them unless `includePrepared`; clustering, phones, counts and summaries skip them. Only
  `usePrepared()` turns them into `new` (re-timestamped). Saving a session with a
  `prepared` list replaces only the unused ones.
- Summary recipients: `SUMMARY_DEFAULTS` property `{facilitators, extra}`, overridden by a
  session's `summary: {mode:'custom', ...}`; always resolve with `summaryRecipients_()`.
  Extra addresses may be outside the domain. The summary must always show original
  wording plus the English translation (`sameLanguage_` decides when one line suffices).
- The wait between questions is per session (`cooldownSeconds`, 0–3600). The cache stores
  when a phone last asked, not when its wait ends, so a changed setting applies to phones
  already waiting; phones re-sync every 15 seconds while counting down.
- The script owner is always an admin. `ADMINS` and `MODERATORS` are comma lists in
  Script Properties; moderators see only sessions they are assigned to.
- **The room screen needs no sign-in by the owner's decision**, but since 2.6.0 its link
  carries its own key: `?view=present&s=<id>&r=<screenKey>`, and `getRoomScreen(sid, layout,
  key)` checks it (signed-in QA Facilitators for the session don't need it). The session id
  alone is in every participant link and QR code, so without the key a forwarded
  participant link could be turned into a room screen showing live codes. Sessions from
  before 2.6.0 get a key from `screenKeyFor_()` the first time links are made;
  `regenerateLink(sid, 'screen')` replaces it. Do not add a sign-in without asking.
- Participant links, QR codes and the room screen link use `participantBaseUrl_()`, which
  converts either domain-scoped form to `/macros/s/…`. Guests and venue browsers are
  signed into their own Google accounts, and the domain form fails for them with Google's
  "Sorry, unable to open the file at this time". Queue and admin links keep the reported
  form (they need a staff sign-in anyway).
- Ending or deleting a session requires the session name typed back
  (`requireTypedName_`, case and spacing forgiven). Session order is `order` on each
  session, set by `reorderSessions()`; new sessions go on top.
- Pages never use `confirm()`/`alert()`: in the sandbox they show a googleusercontent.com
  address. Use the in-page dialog helpers in `Admin.html` and `Moderate.html`.
- **Admins and moderators must be in the owner's Workspace domain.** With execute-as-
  owner and anonymous access, `getActiveUser()` is empty for everyone outside the
  domain, so an outside moderator can never be recognized. `addPerson()` enforces it.
- Every public top-level function is callable by anonymous visitors via
  `google.script.run`. Anything privileged checks `requireAdmin_()` or
  `requireSession_()`; internal helpers end in `_` (Apps Script refuses to call those).
  `setUp()` is admin-only for this reason. Trigger handlers cannot rely on
  `getActiveUser()`, so scheduled work calls unchecked `_` variants (`endSession_`).
  The trigger handler itself must stay public, so `clusterQuestions(e)` checks
  `e.triggerUid` against the project's triggers (or an admin) before calling `clusterAll_()`;
  tests call `clusterAll_()` directly.
- Only guest-facing pages (Ask, Present, Denied) set `ALLOWALL` framing; Admin and the queue
  keep Google's default so other sites can't frame them.
- Pages must not declare top-level names that are window properties (`status`, `name`,
  `top`, …): `var status` silently became a string and hid the room screen's status line.
  `tests/pages.test.js` checks this.

## Me too, Now answering, schedule, health, load test

- Single questions not in a topic can be shown on phones too (`setQuestionShown`,
  `session.shownQuestions`, Me too key `singleKey_(id)` = `q:<id>`); showing marks the row
  `ungrouped` and translates it (`translatePrepared_(sid, ids)`); `groupQuestions` carries
  its approval and votes to the topic.
- Participants never see anyone's question text unless a facilitator shows or answers that
  question, and see a topic label only after a
  moderator approves it (`setTopicShown`, `Topics` column G = `yes`). `getTopics()`
  returns approved Gemini topic labels translated into `CONFIG.displayLanguages`; translations come back in the same
  grouping call (`labels` in the schema) and are stored in `Topics` column E. The
  moderator-language label stays the grouping key — do not group on translations.
- A full room polls `getTopics()` every 30s, so the topic list is cached per session for
  `CONFIG.topicCacheSeconds`; `invalidateTopics_()` after anything that changes it.
  Votes are `VOTES_<id>` in Script Properties; each device's own votes are in cache.
- The every-minute `clusterQuestions` trigger also runs `runSchedule_()`. A schedule
  starts a session once (`scheduleStarted`), so a manual deactivate sticks. A scheduled end
  in the past is refused on save. A summary that fails when a session ends is kept as
  `summaryPending` and retried every 30 minutes for a day.
- Grouping: one run per session at a time (`grouping:<id>` cache flag); questions go to
  Gemini as one JSON object per line; a question Gemini answered for but skipped 3 times
  (`tries:<qid>`) is left for the facilitator. Outages and bad keys don't count as tries.
- Room codes: `previous` is only carried over (and honored) if it was on screen within the
  last rotation, so a code photographed before the screen was closed stays dead.
- Me too has a room-wide per-minute cap (`CONFIG.meTooLimitPerMinute`).
- `noteGroupingResult_()` counts consecutive grouping failures and emails admins after
  `CONFIG.alertAfterFailures`, then again on recovery. Idle minutes are not recorded.
- `doPost` is the load-test endpoint. It does nothing unless an admin started a load
  test (`LOADTEST` property: 32-hex key, one throwaway session, 60 minutes). Only that
  path skips the per-session cap; `submitQuestion()` from pages never can.
- Grouping writes find rows by question ID under the lock after the Gemini call, since
  rows can move (session deletion) while Gemini is working.
- Logos are in the `Assets` sheet (45,000 characters per cell) and cached 6h, not in
  Script Properties, so per-session logos don't exhaust the 500KB property store.
- Participant questions and Gemini output go through `sheetSafe_()` so a leading `=`,
  `+`, `-` or `@` is stored as text, never evaluated. CSV export guards the same way.

## Constraints that drove the design

**The audience is anonymous and outside the Google domain.** They arrive by scanning
a QR code. This is the single most important fact about this project. It means
`Session.getActiveUser().getEmail()` returns empty, Apps Script exposes no client IP,
and there is no server-side signal to identify a person. Per-person rate limiting is
therefore impossible, and anything claiming to do it is theater.

What exists instead:

- A 5-minute cooldown keyed to a localStorage device token. Friction, not
  enforcement — beatable via incognito. Kept because it stops the common case.
- A rotating entry token. The room screen regenerates the QR every 150s; a scan
  exchanges that short-lived token once for a long-lived device token. A URL
  forwarded outside the room goes dead. This scopes submission to physical
  presence, which is the strongest guarantee available here.
- A room-wide cap of 120 questions/minute (was 15 until 2.19, when submissions stopped
  queuing for the sheet). Identity-free flood protection; approximate under bursts.
- **Clustering is the real spam defense.** Twenty questions from one person collapse
  into one topic card the facilitator dismisses once. If a change would weaken
  clustering to strengthen the cooldown, it is the wrong trade.

**Questions arrive in English, Korean and Spanish.** Language detection, translation
and topic assignment all happen in a single Gemini call inside `clusterQuestions()`,
so translation costs nothing beyond clustering. Topic labels are always written in
`CONFIG.moderatorLanguage` regardless of source language — this is deliberate and
load-bearing: it is what makes a Korean and a Spanish question about the same theme
land in the same group rather than forming parallel topics that never meet.

The merge and translate prompts both explicitly instruct Gemini not to soften
criticism. A facilitator reads these aloud to a room containing native speakers of
the original, so a sanitized translation is a real failure mode. Preserve that
instruction in any prompt edits.

## Known risks, unresolved

- **Concurrency is the likely failure mode, not quota.** An anonymous web app runs
  every request as the owner, and Apps Script caps simultaneous executions. A full
  room submitting at once is untested. Load-test before going live; daily quotas are
  nowhere near binding at this scale.
- Publishing a web app to "Anyone" may be blocked by Workspace admin policy. Confirm
  before investing further.
- `CONFIG.model` is `gemini-3.5-flash`, the default. Admins can change the model, thinking
  per task (`grouping`, `merging`, `translating`: `default` sends no `thinkingConfig`, others
  set `thinkingLevel`), temperature and grouping batch size under Admin → Health → Gemini
  (`GEMINI` property, `geminiSettings_()`, read on every `geminiRequest_(prompt, schema,
  {task})`). A 400 mentioning thinking is retried without `thinkingConfig`. Google retires
  model IDs on a schedule; a clustering failure months from now is probably a 404.
- Links in QR codes and emails come from `ScriptApp.getService().getUrl()` unless an
  admin sets the app address (`PUBLIC_URL`) on the Branding tab. With several
  deployments that detected URL may not be the live one; set it if links misbehave.
- Adding an OAuth scope (as `script.send_mail` was) requires running `setUp()` in the
  editor before the new version serves traffic, or every request fails authorization.

## Conventions

- No build step, no framework, no npm dependencies in the web app itself. Plain ES5-
  compatible JS in the HTML files, since `google.script.run` is the only transport.
- System font stack, no webfonts. These pages load on weak venue wifi.
- Gemini calls use `responseSchema` with `responseMimeType: 'application/json'`.
  Keep structured output rather than parsing prose.
- `clasp push` overwrites remote and `clasp pull` overwrites local. No merge. Local
  is the source of truth; do not edit in the web editor.
- Install-specific values never go in git: `.clasp.json` (script ID) and `.deploy.env`
  (`QD_DEPLOYMENT_ID`, `QD_CLASP_USER`) are ignored; copy the `.example` files. On the
  maintainer's machine the clasp account is named, so always pass `--user` as set there.
- Tests and docs use `example.org` addresses. `scripts/check-secrets.js` rejects any
  other email address, API keys, tokens, and Apps Script IDs.

## Testing and shipping

- `node --test tests/*.test.js` — runs in well under a second, no npm install. The
  pre-commit hook (`.githooks`, enabled via `git config core.hooksPath .githooks`)
  runs it on every commit.
- `tests/harness.js` loads the real `Code.js` with fakes for Properties, Cache, Lock,
  Session, Spreadsheet, Mail, UrlFetch (Gemini), Script and Html services, plus a
  controllable clock. The fakes enforce the 9KB property limit and record any string
  the sheet would evaluate as a formula. Use `createApp().install()`, `h.session()`,
  `h.join()`, `h.ask()`, `h.as(email)` and `h.advance(seconds)`.
- `node scripts/preview.js` serves every page with demo data on localhost (pick the user
  with `?as=owner|mod|anon`); `node scripts/screenshots.js` regenerates
  `docs/screenshots/`. The screenshot script must call Chrome asynchronously — the preview
  server runs in the same process.
- `tests/pages.test.js` statically checks the HTML: scripts parse, ES5 only, every
  `google.script.run` call names a public function that exists, manifest scopes match
  the services `Code.js` uses, and every page is on the `.claspignore` allowlist.
- New behavior gets a test in the matching file (roles, sessions, participants,
  moderation, topics, email, branding, operations, home, setup, repo). Fix a bug by
  first writing the test that fails. `tests/loadtest-script.test.js` runs the real
  load-test script against a local HTTP server backed by `doPost`.
- `npm run test:browsers` (Playwright, dev-only) renders pages from `scripts/preview.js`
  in **WebKit and Chromium**: room screen at many sizes and layouts (exactly one QR SVG,
  fully on screen, no overlapping parts, clock ticking), queue buttons updating before a
  deliberately slow server, iPhone participant page. Every visual change needs a check
  here — Node tests can't see layout. PowerPoint's own web view still isn't covered;
  test slides on a real Mac and Windows machine.
- `browser-tests/visual.test.js` screenshots key pages from fixed demo data
  (`serve(0, { fixedTime })`, Los Angeles time zone, animations off, clocks/QR masked) and
  compares them with `browser-tests/baselines/<platform>/` using pixelmatch (0.2% pixel
  tolerance). Intended visual changes: `npm run test:visual:update` on macOS, and commit the
  Linux baselines from the CI artifact `visual-output` (`gh run download`). A platform with
  no baseline records one and passes.
- `scripts/smoke-live.js` checks the deployed app anonymously (WebKit iPhone + Chromium,
  public and domain address forms). `ship.sh` runs it after deploying and prints a
  rollback command on failure. It cannot simulate a browser signed into other Google
  accounts.
- Queue actions are optimistic in `Moderate.html` (`act`, `send`): change `state`, redraw,
  then save; polls don't overwrite while a save is in flight. Server reads go through the
  per-execution cache (`questionValues_`, `topicValues_`); writes must call
  `questionsChanged_()` / `topicsChanged_()`. `tests/harness.js` resets it per call.
- Present.html's CSS order matters: the wide grid layout (brand/footer, words + code, Now
  answering, status + clock rows), then the `@media (max-aspect-ratio: 5/4)` stacked layout,
  then the `qr-only` slide rules last. Nothing is `position: fixed` except the band and the
  slide's clock. `fit()` lowers the `--fit` font multiplier until no part overlaps or leaves
  the screen; call it after anything changes content or layout. The QR code is one SVG
  drawn by `qrArt()` from qrcode.js's model (rounded corners only, 2-module quiet zone in
  the viewBox) — never let the library draw its canvas/img pair into the page. The
  `qr-art` block is copied verbatim into Sheet.html; a test keeps them identical, and the
  browser tests decode the on-screen code with jsQR.
- Releases: bump `APP.version` in `Code.js` (semver) and add a dated `CHANGELOG.md`
  section. `scripts/ship.sh "what changed"` then runs the secret scan and tests, pushes,
  creates an Apps Script version, redeploys the same live URL, tags `v<APP.version>`,
  and creates the GitHub release from the changelog. It refuses uncommitted work and
  already-released versions. A plain `clasp push` only updates HEAD.
- The repository is public under Apache 2.0. CI (`.github/workflows/test.yml`, actions
  pinned by SHA) runs the secret scan and tests; `main` is protected against force-push
  and deletion.
