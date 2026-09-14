# Changelog

All notable changes to Question Desk. Versions follow [Semantic Versioning](https://semver.org/).
Each release is tagged `vX.Y.Z` and published as a GitHub release by `scripts/ship.sh`,
which reads the notes for that version from this file.

## [2.17.0] - 2026-09-13

### Changed
- **Submissions no longer wait for the spreadsheet.** Each question is saved to its own
  Script Properties entry — durable, a few milliseconds, and no waiting in line, because no
  two submissions share an entry — and written to the Questions sheet in one batch: on
  each queue refresh (so it appears within about 5 seconds), every minute, and before
  anything that needs every question (grouping, summaries, ending or archiving a session).
  A batch that's interrupted can't write a question twice. A full room now submits about
  as fast as one person.
- **Batched cell updates.** Marking answered, dismissing (including **Dismiss all**),
  grouping and ungrouping by hand, adding prepared questions and retention each update
  their cells in one call instead of one per question.
- **Shared queue board.** The queue's questions and topics are cached per session and
  shared by every facilitator's refresh, and cleared by any change, so several open queues
  no longer each read both sheets every 5 seconds. Me too counts and switches stay live.
- **Buffered activity log.** Log entries are saved the same way as submissions and
  written to the sheet in batches (every minute, and whenever the Activity tab loads), so
  logging no longer adds a spreadsheet write to each queue click.
- The load test reports how long saving took ("save") instead of lock timings.

## [2.16.0] - 2026-09-13

### Fixed
- **Questions could be lost when many phones submitted at once (2.14.1–2.15.0).** A
  40-at-once load test saved only 15 of 40 questions: 2.14.1 moved the spreadsheet append
  outside the script lock, and parallel appends overwrote each other. The append is back
  inside the lock (the spreadsheet is still opened before it, which kept most of the speed
  gain), submissions now queue up to 30 seconds for their turn instead of getting "busy"
  after 10, and a test fails if a question is ever written without the lock.

### Added
- **Translate prepared questions when saved** (session option, on by default). As soon as
  the session is saved, Gemini detects each prepared question's language and translates it
  into English and **only the session's languages** (its event's choice, or the site's).
  The queue's Prepared list shows the English wording with a language tag and what phones
  and the room screen will show; **Add to queue** brings it in already translated; and
  **Answer now** on it shows it in each of the session's languages. If Gemini is down at
  save time, the every-minute run tries again, and adding a language to the event later
  fills in the missing translation. Also in the sessions CSV.

### Changed
- Questions a facilitator ungroups are marked in a new *Grouping* column of the Questions
  sheet (previously the language column held a placeholder), so questions that are already
  translated are still grouped automatically. Run `setUp()` in the editor to add the column
  headers, or they're added the next time it runs; the app works either way.

## [2.15.0] - 2026-09-13

### Added
- **Questions no longer wait for grouping.** An ungrouped question has its own **Answer
  now**: the room screen and phones show that question (in English, translated when it was
  asked in another language).
- **Group by hand.** Tick questions anywhere in the queue (or press **X**) and a bar offers
  **Group as…** (type a new topic or pick an existing one — also moves questions between
  topics), **Ungroup**, **Answered** and **Dismiss** for all of them at once. Questions
  grouped by hand keep their topic and are still translated by the every-minute run.
  Ungrouped questions stay ungrouped.
- **Group automatically** switch in the queue (per session, on by default). Off, Gemini
  still translates new questions but doesn't group them; **Group now** still groups on
  request.
- **Show on phones when answering** switch in the queue (per session): **Answer now** also
  approves the topic for phones.

### Changed
- Marking what's being answered as answered or dismissed — the live question, or the last
  open question of the live topic — takes it off the room screen and phones automatically.
- Topics whose questions are all answered leave participants' phones. The phone that asked
  still shows "✓ Answered" beside its own question.

## [2.14.1] - 2026-09-13

### Fixed
- **Submissions no longer queue single file.** Each question held the app-wide lock while
  opening the spreadsheet and appending its row, so a room submitting at once waited in
  line (1.3 s typical inside the script with only 5 at once, heading for "busy" at 40+).
  The spreadsheet is now opened before the lock and the row appended after it
  (`appendRow` is atomic); the lock covers only the quick checks.
- **The load test tells lost replies from lost questions.** Apps Script answers a POST
  with a redirect, and Google sometimes serves its own HTML page there even though the
  question was saved. The script now reports those as "reply lost (Google page)", checks
  how many questions were actually saved, and shows where the time went (opening the
  sheet, waiting for the lock, holding it, appending). Phones don't use that path.

### Added
- Visual comparison tests in CI (development only): key pages are screenshotted and
  compared with saved baselines on every push.
- SETUP.md: how to confirm grouping runs, and a dress rehearsal checklist.

## [2.14.0] - 2026-09-13

### Added
- **Data retention** (Health & testing → Data and reports): keep question wording, or remove
  it 3, 6, 12 or 24 months after a session ends. Removal replaces the original wording, the
  translation and merged questions — and questions quoted in the activity log — with a
  note, and applies to archived sessions too. Topics, languages, answered status, times and
  counts stay. Off by default; turning it on asks first. Logged as "Retention (automatic)".
- **Weekly report** to administrators, Mondays after 8 a.m.: grouping, Gemini, email quota
  and settings storage health; summaries still owed; sessions coming up in the next 7 days,
  active now and ended last week; and questions asked. On by default, with an off switch
  and **Send me the weekly report now**.
- **Settings storage meter** on the Health tab and in the health check: how much of the
  500 KB Google allows for sessions, events and people is used.
- **The queue stays useful when Gemini is down.** After two failed grouping runs, the queue
  says grouping isn't working, and ungrouped questions are sorted into groups by a word
  they share ("Not yet grouped · mentions “parking”"). The same sorting helps whenever
  questions have waited more than 3 minutes. Nothing is written, so real grouping and
  translation take over as soon as Gemini is back.

### Changed
- The queue's keyboard shortcuts button now says **Shortcuts**.

## [2.13.0] - 2026-09-13

### Added
- **Day-of checklist** (event **More** menu): a readiness check for the whole app — grouping
  trigger, Gemini, email quota — and for each session: active or starting on its own, end
  time, QA Facilitators, summary recipients, guest page and prepared questions. Each line is
  ✓ ready, ! worth a look, or ✗ needs fixing, and every session's links are there to copy.
- **Print QR sheets**: a printable page per shareable-link session in the event, with the
  QR code, session name and heading, "Scan to ask" in the event's languages, and the link.
- **Email summary for the whole event**: one email with every session's topics and
  questions, and one CSV with a Session column.
- **Event-level QA Facilitators**: assign people on the event's form and they can run every
  session in it, and get those sessions' summaries when summaries go to QA Facilitators.
- **Duplicate** a session (same settings, facilitators and prepared questions; not active,
  not scheduled, new links) or a whole event (branding, languages, logo, QA Facilitators
  and all its sessions) — for recurring meetings.

### Changed
- An event's less-used actions moved into a **More** menu; **Delete event** is there too.

## [2.12.1] - 2026-09-13

### Fixed
- The Admin page and QA Facilitator queue jumped a few pixels sideways when collapsing or
  expanding events, switching tabs, or whenever the page got shorter or taller than the
  window: the scrollbar appeared and disappeared. Its space is now always kept.

## [2.12.0] - 2026-09-13

### Added
- **Languages per event.** Chinese (Simplified), Vietnamese, Tagalog and Armenian join
  English, Korean and Spanish. **Branding → Languages** sets the site's languages; an event
  can choose its own (up to four including English). The participant page's language
  buttons, the room screen's instructions and "Now answering" lines, the landing page, and
  Gemini's topic and merged-question translations all follow the session's languages.
  Adding a language to an event later fills it in for existing topics on the next grouping
  without changing wording phones already show. The new languages' page text should be
  checked by a native speaker.
- **"Answered" on your own phone.** When a facilitator marks a question answered, the phone
  that asked it shows "✓ Answered" beside it and a short note. Only that phone learns it.
  Questions you asked now stay listed on your phone after a reload.
- **Larger text** button (A+) on the participant page, remembered on the phone.
- **High-contrast room screen theme** (black, white and yellow) for low vision and
  washed-out projectors; **T** on the room screen now cycles dark → light → high contrast.

### Changed
- Screen readers: the question box has a translated label, the language switcher is named,
  and notes and "Now answering" are announced when they change.

## [2.11.1] - 2026-09-13

### Fixed
- Collapsing and expanding events snapped open and shut and nudged the header's border.
  Sessions now slide open and closed, the header stays still, and hidden sessions can't be
  tabbed into.
- An event's ▲ ▼ reorder arrows sat right next to its collapse arrow; they're now at the
  far end of the header.
- **Collapse all events / Expand all events** now updates when events are folded one at a
  time, and folds all events together with the same animation.

## [2.11.0] - 2026-09-13

### Added
- **Keyboard shortcuts in the QA Facilitator queue.** J/K or ↓/↑ select a question; A marks
  it answered (or reopens it) and D dismisses it, both moving on to the next question;
  N is Answer now or Stop answering for its topic; P shows or hides the topic on phones;
  M merges the topic; G groups now; O shows original wording; Esc clears. Press **?** or
  the ⌨ button for the list. Shortcuts never fire while typing in a field.
- **Timer for the topic being answered**: "Answering now · 3:12" on the queue.
- **Panelist view** (`view=panel`): the question being answered in large type, with its
  topic, a running timer (amber after 5 minutes), the time and a connection warning.
  Nothing else — no queue, no QR. For a tablet or laptop on the panel table. Find it under
  **Links** on the Admin page and in the queue header. It uses the room screen link's key
  and follows the session's guest page choice for the room screen.

## [2.10.0] - 2026-09-13

### Added
- **Collapse and expand events** on the Sessions tab: click an event's arrow or name, or use
  **Collapse all events** / **Expand all events**. The session count stays visible, and your
  browser remembers which events are collapsed.

### Changed
- **A fresher look** across the Admin page, QA Facilitator queue, participant page,
  landing page and notices:
  - Softer page background with white cards, rounder corners and gentle shadows.
  - Buttons and fields with smooth hover and press states, and a clear focus ring in your
    brand color for keyboard users.
  - Tabs with a sliding accent underline; forms and dialogs ease in; dialogs blur the page
    behind them.
  - "Active" badges pulse gently; language buttons and Me too are pill-shaped; the
    participant page has a light accent wash and a bolder Send button.
  - Each event's card has an edge in its own accent color.
  - Motion is switched off for people who ask their device to reduce motion.
  - The room screen is unchanged.
- The pages share one stylesheet (`Styles.html`), inlined by the server so they still load
  in a single request.

## [2.9.0] - 2026-09-13

### Added
- **Activity log.** A new **Activity** tab on the Admin page shows who did what and when,
  newest first, with search and a session or event filter. It records:
  - **Administrators:** sessions created, edited (with what changed), activated, ended,
    deleted, archived and restored; links replaced; events; people added and removed;
    branding, logos and summary recipients; summaries and links emailed; CSV export and
    import; load tests.
  - **QA Facilitators:** questions marked answered, dismissed or reopened (with the
    question), Answer now, topics shown on or hidden from phones, merges, pausing and
    resuming, prepared questions added, Group now.
  - **The schedule:** sessions it started, ended and archived.
- The full log is the new *Activity log* tab of the spreadsheet; the newest 20,000 entries
  are kept. Participants' questions are not logged there, and logging can never block an
  action.

## [2.8.0] - 2026-09-13

### Added
- **Export CSV** on the Sessions tab downloads every session's settings: event, name,
  heading, how people join, theme, wait, length limit, summary email and recipients,
  schedule, QA Facilitators, guest page, session branding, prepared questions and status.
- **Import CSV** takes that file back (or one you make): **Check file** previews every row
  as Create, Update, Skip or Problem before anything is saved, and **Import** applies it.
  - A row matches an existing session by **name + scheduled start + scheduled end**, or by
    **name alone** when it has no times. Choose whether matches are updated or skipped.
  - Only the *Session* column is required; columns left out keep their current settings.
  - Events named in the file are created if they don't exist.
  - Times are in the app's time zone and accept `2026-10-03 18:30` or `10/3/2026 6:30 PM`
    (how Sheets and Excel save them).
  - Rows with problems (bad times, unknown values, an end already passed, the same
    session twice) are listed by row number and not imported; the other rows still are.
  - Ended sessions are never changed.

## [2.7.0] - 2026-09-13

### Added
- **Events.** An event groups the sessions held at one event, such as a conference with
  several rooms. On the Sessions tab, sessions are listed under their event, with **Add
  session**, **Edit event** and **Delete event**, and events can be reordered. A session's
  new **Event** field moves it between events.
- **Event branding** overrides the site branding for the event's sessions: organization
  name, accent, welcome text, footer, room screen backgrounds and logo. Blank fields use
  the site's; a session's own name, accent and logo still win.
- The queue's session switcher, the landing page, the session picker and summary email
  subjects show the event name.
- **Archive.** Ended sessions move to *Archived sessions* 30 days after they end, or with
  the new **Archive** button, keeping the app's settings storage from filling up.
  **Restore** brings one back. Questions always stay in the spreadsheet.

## [2.6.0] - 2026-09-13

### Upgrade note
**Copy room screen and PowerPoint slide links again** (Admin → Sessions → Links) and paste
them into open room screens and slides. Old links show "This room screen link is out of
date". Participant QR codes and questions links don't change. A self-hosted copy of the
guest page needs the new `join-url.js`.

### Security
- **Room screen links have their own key.** The session id is in every participant link
  and QR code, so anyone with a forwarded participant link could previously open the room
  screen and get a live code. Now the room screen and slide need the key in their link
  (signed-in QA Facilitators for the session don't). **Replace room screen link** on the
  Links panel retires a leaked one.
- **Translations are reviewed too.** The queue shows the Korean and Spanish wording of each
  topic label ("Phones show it as …") and of merged questions, which phones and the room
  screen display, so facilitators see what they approve.
- **A self-hosted guest page can be locked to your app** with `data-only-deployment` in its
  `index.html`, so your site's address can't be used to show another Apps Script app.

## [2.5.0] - 2026-09-13

Fixes from a full code review.

### Fixed
- **Room screen:** "Questions are paused", "Waiting for this session to start" and the
  connection warnings never showed (a page variable clashed with a browser built-in).
- **Security:**
  - The grouping trigger function could be called by anyone, spending Gemini quota. It now
    runs only for its trigger or an administrator.
  - A room code photographed before the room screen was closed worked again for a few
    minutes when the screen reopened.
  - The Admin page and queue could be framed by other websites.
  - The QR code library is now checked against its published integrity hash.
  - Each question goes to Gemini as its own JSON line with a clear instruction to ignore
    instructions inside it.
  - Me too taps have a room-wide per-minute cap.
- **Sessions and email:**
  - A scheduled end time that has already passed is refused instead of ending a live
    session for good.
  - A summary email that fails when a session ends (for example, out of email quota) is
    retried every 30 minutes for a day. The session's line on the Admin page says so.
  - Summary emails go to each recipient separately, so outside recipients don't see
    everyone's address.
  - A Korean or Spanish question Gemini didn't translate is marked "not translated" in the
    summary instead of passing as English.
  - A question submitted as a session ended can no longer slip in afterwards.
- **Grouping:**
  - Questions Gemini keeps skipping no longer block every question behind them, and the
    health check reports it.
  - "Group now" and the every-minute run no longer group the same questions twice.
  - Logos of a certain size could be stored as a broken formula.
- **QA Facilitator queue:**
  - A background refresh that started before a click could undo it on screen for a few
    seconds.
  - The ⋯ menu, "Merging…" state and keyboard focus survive the 5-second refresh (no more
    double merges).
  - Failed saves show a message for 10 seconds instead of a flash.
- **Participant page:**
  - Unlocks by itself when a paused or not-yet-started session opens, and locks when the
    session ends.
  - A raised wait between questions no longer erases what someone is typing.
  - "Sent" stays on screen when there's no wait.
  - Switching language re-translates a locked message.
  - A refresh can no longer un-tick a Me too tap.
- **Admin:**
  - Saving a session no longer replaces its prepared questions unless they were edited.
  - The wait field accepts any number of seconds.
  - "Ending…" and "Checking…" reset after a failure.
  - A rejected summary recipient address stays in the box.
  - A slow logo load can't show on another session's form.
- **Guest page and add-in:** links with tracking tags (fbclid, utm_…), `&amp;` or a
  `#fragment` (from social media, newsletters, Outlook or Teams) now work.

### Changed
- The release check confirms the new version is the one serving and that server calls
  answer, and always checks the guest page. `ship.sh` refuses to ship a commit that isn't
  on GitHub, shows clasp's error when versioning fails, and cleans up if pushing the tag
  fails.
- The secret scanner reports files it can't read, handles accented file names, and
  catches Apps Script project links and OAuth client secrets.
- The load test rejects invalid `--count` and `--rounds`.

## [2.4.4] - 2026-09-13

### Changed
- A session's guest page choice is now two checkboxes under **Use the guest page for**:
  **Room screen** (the room screen link and its QR code) and **PowerPoint slide** (the
  slide's QR code). A shareable questions link uses the guest page when either is ticked.
  Sessions already set to "Guest page" have both ticked; sessions set to "directly" have
  neither.

## [2.4.3] - 2026-09-13

### Changed
- **People → Session Summary Email Recipients** is now a card like Administrators and QA
  Facilitators: a list of addresses with Remove (confirmed first) and an add box. The
  checkbox is gone. Each session's QA Facilitators still get the summary as before, and a
  session can still set its own recipients on its form.

## [2.4.2] - 2026-09-13

### Fixed
- Saving a session set to **Guest page** with its address box empty no longer fails when
  the Branding address is blank or wasn't saved. Blank uses the Branding address, and
  if that is blank too, this project's GitHub Pages guest page.
- QA Facilitator queue: the Reopen button on answered questions was struck through.

### Changed
- QA Facilitator queue is easier to scan:
  - The topic being answered pins to the top, with an "Answering now" tag.
  - Topic buttons are ordered Answer now → Show on phones → Merge.
  - **Dismiss all** moved into a ⋯ menu.
  - Answered questions show a "✓ Answered" tag instead of strike-through.
  - Row buttons are smaller, and they wrap under the question on phones.
- Queue toolbar:
  - An **Accepting questions / Paused** switch replaces "Pause submissions".
  - "Show original wording" is a checkbox.
  - An "Updated" time warns if refreshes stop.
  - The Refresh button is gone; the queue refreshes every 5 seconds.
- **People → Summary email recipients** is an add/remove list like QA Facilitators and
  Administrators, with a checkbox for each session's QA Facilitators. The list may be
  left empty.

## [2.4.1] - 2026-09-13

### Fixed
- The Branding tab made it easy to paste the guest page address into the wrong field ("App
  address"). That field is now under **Advanced** as "Question Desk Google address" with a
  note to leave it blank, and a guest page address pasted there gets an error pointing to
  the right field.
- A rejected branding field no longer leaves the other fields half-saved.

## [2.4.0] - 2026-09-13

### Added
- **Guest page** (`docs/join`): a two-file page hosted on any website (this project's
  GitHub Pages copy, or your own such as autismla.org) that shows the questions page and
  room screen inside it. Safari and Firefox then send Google no sign-in, which avoids
  Google's "Sorry, unable to open the file at this time" for browsers signed into several
  Google accounts. Set the address on **Branding → Guest page address**; choose per session
  under **Open guest pages through** (with an optional per-session address). QR codes,
  questions links, room screen links and emailed links follow the choice.
- The PowerPoint add-in accepts guest page room links.
- The live check after each release also loads a room screen through the guest page.

## [2.3.3] - 2026-09-12

### Added
- Help for Google's "Sorry, unable to open the file at this time", which Google shows
  before Question Desk runs when a browser is signed into several Google accounts: the
  room screen (in English, Korean and Spanish) and the slide caption suggest a private
  browsing window, as do emailed links and the Admin page's Links panel. SETUP.md has a
  troubleshooting section.

## [2.3.2] - 2026-09-12

### Added
- **Installers for the PowerPoint add-in**: a Mac download (`.command`, or a one-line
  Terminal command) and a Windows download (`.cmd`), each with an uninstaller. They
  install for the current user only, need no administrator rights, update in place, and
  refuse a download that isn't the add-in. Tested on real macOS and Windows in CI.

### Changed
- New questions in the queue say **"Waiting to be grouped"** instead of "Translating…".
  Language is detected during grouping, so English questions waited with the same label
  and looked like they were being translated. After a couple of minutes the label points
  to **Group now** and the health check.

## [2.3.1] - 2026-09-12

### Fixed
- In a square slide box, the QR-only view could push the top of the code off the box on
  computers with larger default fonts (found by the new browser tests on Linux). Wide
  boxes now put the caption beside the code; square and tall boxes leave room for it.
- Room screen text scales with the box's height as well as its width, and very small
  boxes drop the footer and extra lines instead of overlapping.

## [2.3.0] - 2026-09-12

### Added
- **Clock on the room screen** with the time the code last updated. If updates stop for
  a minute, the screen says so and fades the code, instead of silently showing an expired one.
- **Dismissed questions are kept** in a *Dismissed* section at the bottom of the QA
  Facilitator queue, each with **Restore**.
- **Browser tests in WebKit and Chromium** (`npm run test:browsers`): room screen at
  projector, slide, square and tall sizes (one QR code, fully visible, nothing
  overlapping, clock ticking), queue buttons responding before the server, and the
  participant page on an iPhone. Run in CI and before every release.
- **Live check after every release** (`scripts/smoke-live.js`): loads the deployed app as
  an iPhone (WebKit) and in Chromium, in both address forms, and prints the rollback
  command if Google returns an error page.

### Changed
- **Queue buttons respond instantly.** The page updates at once and saves in the
  background; each save opens the spreadsheet once and reads each sheet at most once
  (previously 5+ seconds per click).
- **Answered questions sink** to the bottom of their topic, and fully answered topics to
  the bottom of the queue.
- The queue button is now **Answer now** (and **Stop answering**). The room screen and
  phones still show "Now answering".
- The room screen checks for changes every 5 seconds (was 20); phones every 15 seconds
  (was 30), with a 5-second topic cache.
- **Room screen links use the public address**, so they open for guests and venue
  browsers signed into their own Google accounts.
- The room screen adapts to its box: text beside the code when wide, above it when
  square or tall — for any monitor, projector or slide shape.
- The PowerPoint add-in inserts sized to fill a 16:9 slide and no longer saves a snapshot
  image that could show an old code.

### Fixed
- The QR code is drawn as a single SVG. PowerPoint for Mac's built-in browser could show
  the library's canvas and image stacked, one cut off.
- Google's "Sorry, unable to open the file at this time" on the room screen for browsers
  signed into a personal Google account (the room screen link was the domain form).
- The room screen's hover label ("Question Desk room screen") no longer shows on slides.

## [2.2.0] - 2026-09-12

### Added
- **Question Desk QR, a PowerPoint add-in** (`docs/addin`) that shows a session's live,
  rotating QR code on a slide in PowerPoint for Windows, Mac and the web. Served free
  from GitHub Pages; the session link is saved in the presentation. See
  `docs/addin/README.md` for installing it for one computer or your whole organization.
- A **QR-only room screen layout** (`&layout=qr`) sized for a box on a slide, and a
  **PowerPoint slide** link under each session's Links on the Admin page.

### Changed
- Active sessions stand out on the Admin page with a tinted background and accent edge;
  ended sessions are muted.

## [2.1.1] - 2026-09-12

### Changed
- Summary email default recipients moved from the Branding tab to the **People** tab.

## [2.1.0] - 2026-09-12

### Added
- **QA Facilitator approval for Me too.** Topic labels appear on participants' phones only
  after a QA Facilitator presses **Show on phones** in the queue, and can be hidden again.
- **Type the session name to end or delete it.** Checked on the server as well as in
  the page. Scheduled endings are unaffected.
- **Reorder sessions** on the Admin page by dragging, or with the ▲ ▼ buttons. The order
  is used everywhere sessions are listed.
- Screenshots in the README, `scripts/preview.js` (every page with demo data, no Google
  account) and `scripts/screenshots.js`.

- **Prepared questions.** Load up to 100 questions into a session ahead of time. They
  stay out of the queue, off phones and out of the summary until a QA Facilitator presses
  **Add to queue**; then they are translated and grouped like any other question.
- **Summary email recipients.** Set organization-wide defaults on the Branding tab (the
  session's QA Facilitators and/or any other addresses, including outside the
  organization) and override them per session. The end dialog and **Email summary** show
  who will receive it.
- **Time between questions per session.** Set from 0 (no wait) to one hour on the
  session form; the default stays 5 minutes. Changing it during a session applies at
  once, including to phones already waiting, whose countdown updates within 15 seconds.

### Changed
- **Moderators are now called QA Facilitators** everywhere on screen, in dialogs and in
  emails. Nothing about their access changed.
- The **room screen is public**: anyone with its link can show it, signed in or not,
  whatever Google account the browser uses. Only the Admin page and facilitator queue
  require an authorized account. The room screen link itself is unchanged.
- Confirmation prompts are in-page dialogs instead of browser pop-ups that showed a
  `googleusercontent.com` address.
- The room screen gives its heading and instructions more width, hides the mouse
  pointer when idle, and shows the organization name only when there is no logo.
- A deactivated session tells participants it is "not taking questions right now".

### Fixed
- The questions summary always keeps each question's original wording alongside its
  English translation, labels questions that were never translated, and the CSV names its
  columns "Original language", "Original question" and "English translation", with a
  "Topic shown on phones" column.
- Participant links and QR codes always use the public `/macros/s/` address. Google can
  report a domain-scoped `/a/<domain>/macros/s/` address, which asked people signed into
  another Google account to sign in or request access.

## [2.0.0] - 2026-09-12

### Added
- **Admin page** with Sessions, People, Branding, and Health & testing tabs.
- **Multiple sessions**, each with its own queue, room screen, cooldown and question cap.
  Several can run at once. Each is either *In-room QR* (code rotates every 150 seconds)
  or *Shareable link* (fixed link that can be emailed and replaced).
- **Roles**: the script owner is always an administrator; administrators add other
  administrators and moderators (Workspace domain only) and assign moderators per session.
- **Scheduled sessions** that start and end on their own.
- **End-of-session summary email** to moderators with topics, merged questions, every
  question with its original wording, "me too" counts, and a CSV.
- **Email links** to anyone (one message per recipient) and to a session's moderators.
- **Me too**: participants see topic labels in English, Korean or Spanish and can support
  a topic instead of re-asking. No participant's question text is shown to others.
- **Now answering**: facilitators put a topic, and its merged question, on the room
  screen and participants' phones in all three languages.
- **Branding**: organization name, logo, accent color, welcome and footer text, room
  screen background colors, tab icon, and per-session overrides for partner events.
- **Landing page** at the app's main address, with staff links when signed in.
- **Health check** for the Gemini key and model, trigger, sheet, email quota and app
  address, plus automatic admin emails when grouping fails repeatedly and when it recovers.
- **Load test**: a time-limited, keyed endpoint and `scripts/loadtest.js` to simulate a
  full room submitting at once.
- **Version and release notes link** on the Admin page.
- Functional test suite (`node --test tests/*.test.js`), secret scanning, pre-commit hook,
  CI, and `scripts/ship.sh` for tested, tagged releases.

### Changed
- Question length is set per session: 300 characters by default, up to 1024. Oversized
  submissions are rejected before any processing.
- Cooldown responses report the real number of seconds remaining.
- Room tokens expire on their own even when no room screen is polling.

### Fixed
- Participant text and Gemini output can no longer be evaluated as spreadsheet formulas.
- IDs such as `12e45678` are stored as text instead of being converted to numbers.
- `setUp()` can no longer be run by anonymous visitors through `google.script.run`.
- Grouping results are written by question ID, so they land on the right rows even if
  rows move during the Gemini call.

## [1.0.0] - 2026-09-12

### Added
- Anonymous audience Q&A as a Google Apps Script web app: rotating room QR code,
  per-device cooldown, room-wide cap, and a facilitator queue grouped by topic.
- Gemini language detection, translation and topic grouping in one call, with topic
  labels in the moderator's language so questions group across languages.
- "Merge into one question" for reading a topic aloud.
- Participant page in English, Korean and Spanish.

[2.17.0]: https://github.com/djsincla/question-desk/releases/tag/v2.17.0
[2.16.0]: https://github.com/djsincla/question-desk/releases/tag/v2.16.0
[2.15.0]: https://github.com/djsincla/question-desk/releases/tag/v2.15.0
[2.14.1]: https://github.com/djsincla/question-desk/releases/tag/v2.14.1
[2.14.0]: https://github.com/djsincla/question-desk/releases/tag/v2.14.0
[2.13.0]: https://github.com/djsincla/question-desk/releases/tag/v2.13.0
[2.12.1]: https://github.com/djsincla/question-desk/releases/tag/v2.12.1
[2.12.0]: https://github.com/djsincla/question-desk/releases/tag/v2.12.0
[2.11.1]: https://github.com/djsincla/question-desk/releases/tag/v2.11.1
[2.11.0]: https://github.com/djsincla/question-desk/releases/tag/v2.11.0
[2.10.0]: https://github.com/djsincla/question-desk/releases/tag/v2.10.0
[2.9.0]: https://github.com/djsincla/question-desk/releases/tag/v2.9.0
[2.8.0]: https://github.com/djsincla/question-desk/releases/tag/v2.8.0
[2.7.0]: https://github.com/djsincla/question-desk/releases/tag/v2.7.0
[2.6.0]: https://github.com/djsincla/question-desk/releases/tag/v2.6.0
[2.5.0]: https://github.com/djsincla/question-desk/releases/tag/v2.5.0
[2.4.4]: https://github.com/djsincla/question-desk/releases/tag/v2.4.4
[2.4.3]: https://github.com/djsincla/question-desk/releases/tag/v2.4.3
[2.4.2]: https://github.com/djsincla/question-desk/releases/tag/v2.4.2
[2.4.1]: https://github.com/djsincla/question-desk/releases/tag/v2.4.1
[2.4.0]: https://github.com/djsincla/question-desk/releases/tag/v2.4.0
[2.3.3]: https://github.com/djsincla/question-desk/releases/tag/v2.3.3
[2.3.2]: https://github.com/djsincla/question-desk/releases/tag/v2.3.2
[2.3.1]: https://github.com/djsincla/question-desk/releases/tag/v2.3.1
[2.3.0]: https://github.com/djsincla/question-desk/releases/tag/v2.3.0
[2.2.0]: https://github.com/djsincla/question-desk/releases/tag/v2.2.0
[2.1.1]: https://github.com/djsincla/question-desk/releases/tag/v2.1.1
[2.1.0]: https://github.com/djsincla/question-desk/releases/tag/v2.1.0
[2.0.0]: https://github.com/djsincla/question-desk/releases/tag/v2.0.0
[1.0.0]: https://github.com/djsincla/question-desk/releases/tag/v1.0.0
