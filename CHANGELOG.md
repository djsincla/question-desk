# Changelog

All notable changes to Question Desk. Versions follow [Semantic Versioning](https://semver.org/).
Each release is tagged `vX.Y.Z` and published as a GitHub release by `scripts/ship.sh`,
which reads the notes for that version from this file.

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

[2.0.0]: https://github.com/djsincla/question-desk/releases/tag/v2.0.0
[1.0.0]: https://github.com/djsincla/question-desk/releases/tag/v1.0.0
