# Question Desk for WordPress — port plan

Branch: `wordpress`. **Both versions are supported, permanently.** The Google Apps Script app on
`main` stays live, and the plugin is an equal second home for organizations that would rather
run Question Desk on their own site. Neither replaces the other, and neither is being retired.

See [wordpress/README.md](wordpress/README.md) for installing and running the plugin.

## Working on the plugin

Needs Docker Desktop running and `npm ci` done.

| Command | Does |
|---|---|
| `npm run wp:start` | Builds the shared pages and data into the plugin, starts WordPress at http://localhost:8888 (admin / password) and a test site at :8889 |
| `npm run wp:test` | PHPUnit inside WordPress (`wordpress/question-desk/tests`) |
| `npm run wp:browsers` | The plugin in WebKit and Chromium (`wordpress/browser-tests`); skips if WordPress isn't running |
| Admin page | http://localhost:8888/wp-admin/admin.php?page=question-desk (sign in as admin / password) |
| `npm run wp:package` | Builds the installable zip into `wordpress/dist/` |
| `npx wp-env stop` | Stops WordPress |

First run only: `npx wp-env run cli wp rewrite structure '/%postname%/'` so `/questions/` works
(otherwise use `/?qd_page=1`).

`wordpress/build.js` copies the page files from the repo root into `question-desk/pages/` and
writes `question-desk/data/app.json` (UI_TEXT, CONFIG, and the sessions CSV columns and time
format, so the CSV is the same file in both versions). Both are build output (git-ignored):
edit the pages and `Code.js` at the root, as for the Apps Script version.

## Status

- [x] **Phase 0 — scaffold.** Plugin, activation (7 tables, QA Facilitator role, capabilities),
  `/questions/` routing, page rendering (BOOT, style and script sections, text), the REST
  dispatcher with access levels, `qd-run.js` (google.script.run), PHPUnit (11 tests), browser
  test in WebKit and Chromium, CI workflow (`.github/workflows/wordpress.yml`).
- [x] **Phase 1 — settings, people, events and sessions.** Admin.html inside wp-admin, drawing
  from WordPress data: branding and logos (Media Library), site and event languages, events,
  sessions (validation, schedule, links and room screen keys, order, activate, end, delete,
  duplicate, archive and restore), people as WordPress roles, and the activity log behind them.
  The language each person reads the app in is WordPress user meta (`qd_lang`); the site's own is
  the `qd_app_language` option.
  25 Admin functions answer for real; the 16 from later phases say so. 50 PHPUnit tests, and a
  browser test that saves and deletes a session through the REST transport in both engines.
- [x] **Phase 2 — participants.** The participant page on WordPress data: the rotating room
  code and device tokens, asking (length, status, wait between questions, per-session room
  cap), Me too counted by the database itself, the topic list phones poll (approved labels
  only, in every session language), Now answering, and a phone's own answered questions.
  25 more PHPUnit tests and a browser test where a phone joins by link and asks.
- [x] **Phase 3 — room screen, slide, panelist view, QR sheets.** `getRoomScreen` on
  WordPress data (rotating joining link, branding, Now answering, the room's question list,
  version reload), the present/panel/qrsheet routes with their own key, the Denied page as
  session picker, and the PowerPoint add-in accepting a WordPress room screen link. A browser
  test decodes the QR on screen and follows it to a working participant page.
- [x] **Phase 4 — queue.** The QA Facilitator queue on WordPress data: the board (topics sorted
  by interest, ungrouped questions, dismissed, prepared), answering, dismissing and reopening,
  pause/resume, show on phones (topics and single questions, carrying Me toos when grouped),
  Answer now, grouping and ungrouping by hand, and the per-session switches. Gemini does the
  grouping, translation and read-out questions through `wp_remote_post`, with the same prompts
  (including the do-not-soften rule), the thinking-level retry, and the three-tries cap. An
  every-minute WP-Cron run starts and ends scheduled sessions and groups active ones; a queue
  refresh kicks a session's grouping when it is due, since WP-Cron only fires on traffic.
- [x] **Phase 5 — reports and operations.** Summaries by email with the questions as a CSV
  (sent when a session ends, retried for a day if the mail fails), the event summary, one email
  per QA Facilitator with their own sessions, link emails, the day-of checklist, the sessions
  CSV export and import (the same columns as the Apps Script version, from data/app.json), the
  activity log, retention, the weekly report, the health check, and the load test. Every one of
  the Admin page's 41 server functions now answers for real.
- [x] **Phase 6 — packaging and the bridge between the versions.** `npm run wp:package` builds
  `wordpress/dist/question-desk-<version>.zip` (the plugin and its built pages, without the
  tests, composer or vendor), the plugin's version tracks `APP.version` so both versions say the
  same thing, `wordpress/README.md` covers installing and running it, and **Question Desk →
  Import questions** loads a session's questions from the CSV a summary email attaches, so an
  event run on either version can be kept with the other.

## Decisions

| Question | Decision |
|---|---|
| Where it runs | Any standard WordPress (PHP 8.1+, MySQL 5.7+/MariaDB 10.4+). Developed and tested locally with `@wordpress/env` (Docker). |
| Scope | Full parity with the Apps Script app. |
| Apps Script app | Kept and supported alongside the plugin. `main` stays the live app; the plugin lives on this branch. |
| Staff sign-in | WordPress users. Site administrators manage everything; a **Question Desk Admin** role (`qd_admin`) manages it without being a site administrator, and a **QA Facilitator** role (`qd_facilitator`) runs the queues it is assigned to. No Google-domain restriction. |

## What changes and what doesn't

The **pages stay the same files** (Ask, Present, Moderate, Admin, Panel, Home, Denied,
Sheet, Styles.html, Scripts.html). They talk to the server only through
`google.script.run.withSuccessHandler(...).withFailureHandler(...).someFunction(args)`.
The plugin ships a small `qd-run.js` that provides that same object and sends each call to
the WordPress REST API. So one set of pages serves both versions, and fixes carry across.

The **server is rewritten in PHP**, area by area, mirroring `server/*.js`:

| Apps Script | WordPress |
|---|---|
| `doGet` routes (`?view=…`) | Rewrite rules under one page slug (default `/questions/`): `/questions/`, `?view=present`, `?view=moderate`, `?view=panel`, `?view=qrsheet`; Admin as a WordPress admin menu page |
| `google.script.run` | `POST /wp-json/question-desk/v1/call/{function}` with the REST nonce; a public allowlist for participant functions, capability checks for the rest |
| Script Properties (sessions, events, votes, tokens, settings) | Custom tables (below) and `wp_options` |
| Questions / Topics / Archive / Activity log sheets | Custom tables via `dbDelta` |
| Assets sheet (logos) | Media Library attachments |
| CacheService | Transients (`QD_Cache`), so a host with a persistent object cache keeps them out of the database; per-session values carry a version replaced by every change, as in the Apps Script version |
| LockService, the question inbox, batched writes | MySQL: one `INSERT` per question (no inbox, no lock — a test asks 100 in a row and finds 100), `INSERT … ON DUPLICATE KEY UPDATE votes = votes + 1` for Me too, named locks (`GET_LOCK`) only where a whole record is rewritten |
| Every-minute trigger | WP-Cron event every minute, **plus** grouping kicked from queue refreshes when it's due (WP-Cron only runs when the site gets traffic). Recommend a real system cron on the host. |
| `UrlFetchApp` (Gemini) | `wp_remote_post`; API key in settings or a `QD_GEMINI_API_KEY` constant in `wp-config.php` |
| `MailApp` | `wp_mail`, one message per recipient (recommend an SMTP plugin on the host; the checklist and health check say when there isn't one) |
| `Session.getActiveUser` / ADMINS / MODERATORS | WordPress users; capabilities `qd_manage` (Administrator) and `qd_facilitate` (QA Facilitator role); session facilitators stored as user IDs |
| Guest page (`docs/join`) | Supported the same way, so links are shaped alike in both versions (an address on your own site, for printed material or a familiar page). The copy the organization hosts names the site in `data-site`; links never carry a site of their own, so a guest page can only ever show the Question Desk it was set up for. Google's multi-account error, the reason it exists for Apps Script, doesn't arise here. |
| PowerPoint add-in | Accepts the WordPress room screen link too (`room-url.js` learns the WordPress form). The room screen and slide must be frameable: the plugin removes `X-Frame-Options` for those two routes — **a host-level header (like autismla.org's) can't be removed by a plugin; test on the real host.** |

## Data model (custom tables, prefix `{$wpdb->prefix}qd_`)

- `events` — id (8 hex), name, sort, brand JSON, logo attachment id, languages JSON, facilitators JSON, created
- `sessions` — id, event_id, name, status, access, sort, settings JSON (heading, theme, cooldown, max length, schedule, guest page, room questions, translate prepared, auto group, auto show, now answering…), link_key, screen_key, created/started/ended, summary state
- `questions` — id, session_id, submitted, device, text, status, topic, lang, translation, grouping, translations JSON; indexes on (session_id, status), (session_id, topic)
- `topics` — session_id, topic, merged, labels JSON, merged_labels JSON, shown, updated; unique (session_id, topic)
- `votes` — session_id, key, count; unique (session_id, key)
- `activity` — id, at, who, action, target, details
- `archive` — session JSON and votes for archived sessions

Room tokens and device tokens stay short-lived (transients), as in Apps Script.

## Phases

0. **Scaffold** — plugin skeleton, `wp-env` config, activation (tables, roles, options), the
   `qd-run.js` transport, one page rendered end to end, PHPUnit + PHP lint + Playwright in CI.
1. **Settings, people, events and sessions** — Admin page on WordPress data: branding,
   languages, events, sessions, links, reorder, duplicate, archive, people (roles).
2. **Participants** — join tokens, room codes, asking, cooldown, room cap, Me too, answered marks.
3. **Room screen, slide, panelist view, QR sheets** — including the add-in and version reload.
4. **Queue** — statuses, grouping and translation with Gemini (settings, retries, backup
   keyword groups), Read out questions, show on phones, now answering, room list.
5. **Reports and operations** — summaries by email with CSV, event summary, facilitator
   link emails, sessions CSV import/export, activity log, retention, weekly report, health
   check, load test.
6. **Packaging and the bridge between the versions** — installable zip, docs, and importing an
   event's questions from the Apps Script version's summary CSV (sessions already move either
   way through the sessions CSV). Nothing is moved or deleted: both versions stay in use.

Each phase ends with its tests passing (PHPUnit ports of the matching Node tests, and the
browser tests pointed at the `wp-env` site).

## Risks to check early

- **Hosting behaviour during an event:** 100 phones polling every few seconds are PHP requests.
  Page caches (managed hosts, Cloudflare) must never cache the REST API or the room screen.
- **Cron:** without a real system cron, grouping depends on site traffic (mitigated by kicking it
  from queue refreshes).
- **Framing headers** set by the host or a security plugin can block the PowerPoint add-in.
- **Email deliverability** from the host (use an SMTP plugin).
- **Two codebases, on purpose:** both versions are supported, so a server fix is made twice.
  What they share keeps them honest — the pages, the participant-facing text, the CONFIG values
  and the sessions CSV columns are all built from `Code.js` into the plugin, and the same test
  suites cover both. A fix to a page or to wording is one change for both.
