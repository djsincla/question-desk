# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on this repository. Do not open a public issue.

You should get a response within a week. Include steps to reproduce and the version
shown on the Admin page.

## What is in scope

- Bypassing roles: reaching the Admin page, a moderator queue or room screen, or any
  admin or moderator function without the right account.
- Reading or changing another session's questions, votes or settings.
- Injecting script into any page, email or the submissions spreadsheet (including
  spreadsheet formulas).
- Using the load-test endpoint without a valid, unexpired key.
- Leaking participant question text to other participants.

## Known limits, by design

Question Desk's audience is anonymous and outside the organization's Google domain,
so the app cannot identify individual people. The cooldown and "me too" limits are
per browser and can be reset with a private window; the rotating room code and the
per-session question cap are the real controls. See `CLAUDE.md` for the reasoning.
These are not vulnerabilities unless they can be exploited from outside the room.

## For people running their own copy

- Keep `GEMINI_API_KEY` in Script Properties only. Never commit it.
- `.clasp.json` and `.deploy.env` hold your install's IDs and are git-ignored.
  `scripts/check-secrets.js` runs before every commit and in CI to keep them out.
- Use a paid-tier Gemini key for real events so audience questions are not used to
  improve Google's products.
