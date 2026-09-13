# Question Desk

Anonymous audience Q&A for a small nonprofit, built as a Google Apps Script web app
with Gemini doing topic clustering and translation. Runs entirely inside the org's
Workspace account. See SETUP.md for install and deployment.

## Files

- `Code.js` — all server logic (clasp uploads it as `Code.gs`)
- `Ask.html` — participant submission page, localized en/ko/es
- `Present.html` — room screen with rotating QR
- `Moderate.html` — facilitator queue grouped by topic
- `Denied.html` — shown to non-moderators
- `appsscript.json` — manifest; web app set to execute as owner, anonymous access

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
- `cooldownRemaining_()` returns 1 rather than real seconds — the client counts down
  locally from the value returned at submit time. Fine in practice, slightly
  dishonest as an API.

## Conventions

- No build step, no framework, no npm dependencies in the web app itself. Plain ES5-
  compatible JS in the HTML files, since `google.script.run` is the only transport.
- System font stack, no webfonts. These pages load on weak venue wifi.
- Gemini calls use `responseSchema` with `responseMimeType: 'application/json'`.
  Keep structured output rather than parsing prose.
- `clasp push` overwrites remote and `clasp pull` overwrites local. No merge. Local
  is the source of truth; do not edit in the web editor.
