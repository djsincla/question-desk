# Question Desk

Anonymous audience Q&A for community meetings, built as a Google Apps Script web app
with Gemini grouping and translating questions. It runs entirely inside an
organization's own Google Workspace. There is no server to host and nothing for the
audience to install.

Built to support the **Autism Society of Los Angeles**.

[![test](https://github.com/djsincla/question-desk/actions/workflows/test.yml/badge.svg)](https://github.com/djsincla/question-desk/actions/workflows/test.yml)
License: Apache 2.0

## How it works

1. The **room screen** shows a QR code. For in-room sessions the code changes every
   150 seconds, so only people in the room can ask.
2. People scan it and **ask anonymously** in English, Korean, Spanish, or any language.
3. Gemini **groups questions by topic** and translates them in one call, so a Korean
   and a Spanish question about the same thing land in the same group.
4. The facilitator's **queue** shows topics instead of a long list. They merge a topic
   into one question to read aloud, and mark it **Now answering** on the room screen
   and everyone's phone.
5. Participants can tap **Me too** on topic labels, never on other people's questions,
   so the room's priorities surface without repeat questions.
6. When the session ends, QA Facilitators get a **summary email** with a CSV.

## Screenshots

All screenshots use made-up demo data from `scripts/preview.js`.

**Room screen:** QR code, instructions in three languages, the topic being answered, and a
clock showing the code is live.

![Room screen with a topic being answered](docs/screenshots/room-screen-answering.png)

<table>
  <tr>
    <td width="50%"><strong>Participant's phone</strong><br>Ask anonymously; tap <em>Me too</em> on approved topics.<br><br><img src="docs/screenshots/participant-phone.png" alt="Participant page on a phone" width="300"></td>
    <td width="50%"><strong>The same page in Korean</strong><br>Picked from the phone's language, with a switcher.<br><br><img src="docs/screenshots/participant-phone-korean.png" alt="Participant page in Korean" width="300"></td>
  </tr>
</table>

**QA Facilitator queue:** questions grouped by topic across languages, a merged question to
read aloud, *Answer now*, Me too counts, show-on-phones approval, prepared questions,
answered topics sinking to the bottom, and dismissed questions kept for restoring.

![QA Facilitator queue](docs/screenshots/facilitator-queue.png)

**PowerPoint:** the [Question Desk QR add-in](docs/addin/README.md) shows the live code on a slide.

<img src="docs/screenshots/slide-qr.png" alt="QR-only view shown on a PowerPoint slide" width="480">

**Admin:** events and their sessions, people and session summary recipients, branding, and health checks.

![Admin sessions](docs/screenshots/admin-sessions.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/admin-branding.png" alt="Admin branding tab"></td>
    <td width="50%"><img src="docs/screenshots/admin-health.png" alt="Admin health check"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/admin-people.png" alt="Admin people tab with summary recipients"></td>
    <td><img src="docs/screenshots/landing-page.png" alt="Landing page"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/room-screen.png" alt="Room screen"></td>
  </tr>
</table>

Regenerate with `node scripts/screenshots.js` (needs Google Chrome).

## Features

- Events that group sessions, with event branding between the site's and each session's
- CSV export and import of sessions, with a preview before anything is saved
- Activity log of every administrator, QA Facilitator and scheduled action
- Panelist view for the panel table, and keyboard shortcuts in the QA Facilitator queue
- Multiple sessions at once, each joined by in-room rotating QR or a shareable link
- Administrators and per-session QA Facilitators, restricted to the organization's domain
- Scheduled start and end, and end-of-session summaries
- Branding: logo, colors, welcome and footer text, per-session overrides for partner events
- Landing page, health check with failure alerts, and a load-test tool
- Prepared questions, per-session wait between questions, and drag-to-reorder sessions
- [Guest page](docs/join/README.md) that avoids Google's multi-account error for Safari and Firefox
- [PowerPoint add-in](docs/addin/README.md) that shows the live, rotating QR code on a slide (Windows, Mac, web)
- Participant page, room screen and topic labels in English, Korean, Spanish, Chinese, Vietnamese, Tagalog and Armenian, chosen per event; translations never soften criticism
- Larger-text option for participants, a high-contrast room screen, and "Answered" shown on the asker's own phone

## Why it's built this way

The audience is anonymous and outside the Google domain, so the app cannot identify
individuals. Instead of pretending to rate-limit people, it relies on:
- **Presence:** the rotating room code.
- **A per-session question cap.**
- **Topic grouping:** twenty questions from one person collapse into one card the
  facilitator dismisses once.

[`CLAUDE.md`](CLAUDE.md) explains the constraints and design decisions.

## Known issue: "Sorry, unable to open the file at this time"

Google shows this error, before Question Desk runs, to browsers signed into more than one
Google account. Turn on the **guest page** to avoid it for Safari and Firefox:
[step-by-step fix](SETUP.md#sorry-unable-to-open-the-file-at-this-time).

## Getting started

See [`SETUP.md`](SETUP.md) for installation, the Admin page, running an event and
load testing. You need a Google Workspace account that can publish web apps to
"Anyone", and a Gemini API key.

## Development

```bash
node --test tests/*.test.js     # functional tests against fake Apps Script services
npm install && npx playwright install webkit chromium
npm run test:browsers           # real-browser layout and behavior tests (WebKit, Chromium)
node scripts/check-secrets.js   # blocks keys, IDs and real email addresses
git config core.hooksPath .githooks
```

- **No dependencies:** the web app has no build step or npm packages, and the tests
  need only Node 18+.
- **Real code under test:** the tests run the actual `Code.js`, covering roles,
  sessions, tokens, limits, grouping, email, branding, schedules, health alerts and the
  load-test endpoint.
- **Releases:** `scripts/ship.sh` handles them; see [`CHANGELOG.md`](CHANGELOG.md).

## Security

Please report vulnerabilities privately; see [`SECURITY.md`](SECURITY.md).

## License

Copyright 2026 Dwayne Sinclair. Licensed under the [Apache License 2.0](LICENSE).
