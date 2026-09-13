# Question Desk

Anonymous audience Q&A for a small nonprofit, built as a Google Apps Script web app
with Gemini doing topic clustering and translation. Runs entirely inside the org's
Workspace account. See SETUP.md for install and deployment.

## Files

- `Code.js` — all server logic (clasp uploads it as `Code.gs`); `APP.version` is the release
- `Home.html` — landing page at the bare app address; staff links when signed in
- `Ask.html` — participant page, localized en/ko/es; Me too topics and Now answering
- `Present.html` — room screen: QR, Now answering banner, brand colors, light/dark
- `Moderate.html` — facilitator queue for one session, grouped by topic, Now answering
- `Admin.html` — sessions (schedule, per-session branding), people, branding, health, load test
- `Denied.html` — not-allowed page, also the session picker
- `appsscript.json` — manifest; web app set to execute as owner, anonymous access
- `.claspignore` — allowlist of what `clasp push` uploads; add new pages here
- `tests/` — Node test suite that runs `Code.js` against fake Apps Script services
- `scripts/ship.sh` — secret scan, tests, push, version, redeploy, tag, GitHub release
- `scripts/loadtest.js` — simulates a full room against a running load test
- `scripts/check-secrets.js` — blocks keys, IDs and real email addresses (hook and CI)
- `CHANGELOG.md` — release notes; `ship.sh` publishes the section for `APP.version`
- `docs/addin/` — *Question Desk QR* PowerPoint content add-in, served by GitHub Pages
  (`main` branch, `/docs`). `manifest.xml` `<Version>` tracks `APP.version`. The page only
  frames addresses from `room-url.js` (public `/macros/s/` form, `&layout=qr`)

Pages get server data through a single template scriptlet, `var BOOT = <?!= boot ?>;`,
filled by `page_()` with `<` and U+2028/2029 escaped. Do not add other scriptlets, and
never read `window.location` for parameters — pages run in a sandboxed iframe whose URL
does not carry the query string. That exact bug shipped once (v2): every QR scan failed.

## Sessions and roles

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
- **The room screen is public by the owner's decision**: `?view=present&s=<id>` and
  `getRoomScreen()` need no sign-in, so any browser or Google account can show it. Only
  Admin and the queue are gated. For in-room sessions this means the rotating code is as
  private as the room screen link; do not reintroduce a sign-in or key without asking.
- Staff links (room screen, queue, admin) use the address exactly as Google reports it —
  do not rewrite them. Participant links and QR codes use `participantBaseUrl_()`, which
  converts either domain-scoped form to `/macros/s/…` so other Google accounts aren't
  asked to sign in.
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

## Me too, Now answering, schedule, health, load test

- Participants never see anyone's question text, and see a topic label only after a
  moderator approves it (`setTopicShown`, `Topics` column G = `yes`). `getTopics()`
  returns approved Gemini topic labels translated into `CONFIG.displayLanguages`; translations come back in the same
  grouping call (`labels` in the schema) and are stored in `Topics` column E. The
  moderator-language label stays the grouping key — do not group on translations.
- A full room polls `getTopics()` every 30s, so the topic list is cached per session for
  `CONFIG.topicCacheSeconds`; `invalidateTopics_()` after anything that changes it.
  Votes are `VOTES_<id>` in Script Properties; each device's own votes are in cache.
- The every-minute `clusterQuestions` trigger also runs `runSchedule_()`. A schedule
  starts a session once (`scheduleStarted`), so a manual deactivate sticks.
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
- A room-wide cap of 15 questions/minute. Identity-free flood protection.
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
- `CONFIG.model` is `gemini-3.5-flash`. Google retires model IDs on a schedule; a
  silent clustering failure months from now is probably a 404 in the execution log.
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
- The fakes cannot tell you about real Apps Script concurrency, real Gemini output, or
  how the pages render. After shipping, do the phone scan test on mobile data.
- Releases: bump `APP.version` in `Code.js` (semver) and add a dated `CHANGELOG.md`
  section. `scripts/ship.sh "what changed"` then runs the secret scan and tests, pushes,
  creates an Apps Script version, redeploys the same live URL, tags `v<APP.version>`,
  and creates the GitHub release from the changelog. It refuses uncommitted work and
  already-released versions. A plain `clasp push` only updates HEAD.
- The repository is public under Apache 2.0. CI (`.github/workflows/test.yml`, actions
  pinned by SHA) runs the secret scan and tests; `main` is protected against force-push
  and deletion.
