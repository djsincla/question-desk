# Question Desk — setup

Anonymous audience Q&A running entirely inside your Workspace account. Participants
scan a QR code on the room screen, submit a question, and the facilitator sees them
grouped into topics by Gemini instead of as one long undifferentiated list.

## What you need

- A Workspace account that can publish an Apps Script web app to "Anyone"
  (check with your admin first — some tenants block this)
- A Gemini API key from Google AI Studio

## Install

1. Go to script.google.com and create a new project.
2. Create these files and paste in the contents:
   - `Code.gs`
   - `Ask.html`
   - `Present.html`
   - `Moderate.html`
   - `Denied.html`
3. Open **Project Settings → Script Properties** and add:
   - `GEMINI_API_KEY` — your AI Studio key
   - `MODERATORS` — comma-separated emails allowed to see the queue
   - `SESSION_HEADING` — optional, the heading shown to participants
4. Run `setUp()` once from the editor. Approve the permission prompts. It creates the
   submissions spreadsheet, installs the clustering trigger, and logs the sheet URL.
5. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the deployment URL.

## Running an event

| View | URL | Who opens it |
|---|---|---|
| Room screen | `.../exec?view=present` | Whoever runs the projector |
| Facilitator queue | `.../exec?view=moderate` | Moderator, signed in |
| Participant page | reached only by scanning the QR | Audience |

Put the present view on the screen before doors open. The QR regenerates every
150 seconds; a scan trades that short-lived token for a device token stored in the
participant's browser, so people who scanned earlier keep working while a URL
forwarded outside the room goes dead.

Questions land in the sheet within a second. The trigger clusters them every minute,
or hit **Group now** to force it. **Merge into one question** asks Gemini to collapse
a topic into a single question to read aloud — that is the part that saves the
facilitator the most time.

## Working on this locally instead

The editor at script.google.com is fine for a one-off. If you expect to keep
changing this between events, use `clasp` and keep the project in git.

```bash
npm install -g @google/clasp
clasp login
```

You also need to switch on the Apps Script API once, at
script.google.com/home/usersettings — clasp fails with a confusing error if you skip it.

Then either clone what you already deployed:

```bash
clasp clone <scriptId>        # scriptId is in the editor URL
```

or push this folder up as a new project:

```bash
clasp create --title "Question Desk" --type webapp
clasp push
clasp deploy
```

Two gotchas:

- Rename `Code.gs` to `Code.js` locally. clasp treats `.js` as server code and
  uploads it as `.gs`; the HTML files keep their extension.
- `clasp push` **overwrites** the remote project, and `clasp pull` overwrites your
  local files. There is no merge. Pick one side as the source of truth — local, if
  you are using git — and never edit in the web editor once you have.

Command names shifted in clasp 3.x (`create-script`, `create-deployment`), so if a
command comes back unknown, run `clasp --help` and use what it lists.

`appsscript.json` in this folder already sets the web app to execute as you with
anonymous access, so a `clasp deploy` won't silently reset those. Change `timeZone`
to yours before the first push.

## Languages

Participants can submit in any language. The submission page ships with English,
Korean and Spanish and picks one from the phone's own language setting, with a
switcher at the top for anyone whose phone is set to something else.

For the facilitator, translation happens inside the clustering call — one Gemini
request per batch handles language detection, translation and topic assignment
together, so it costs you nothing extra over clustering alone. The queue shows the
translation with a small language tag; **Show original wording** reveals what was
actually typed, which matters when someone disputes how a question was rendered.

Topic labels are always written in the moderator's language regardless of the
question's language. This is deliberate: it's what lets a Korean question and a
Spanish question about the same thing land in the same group instead of forming two
parallel topics that never meet. Set `CONFIG.moderatorLanguage` if English isn't
your facilitator's working language.

`SESSION_HEADING` is a single string, so it appears in whatever language you write
it. Either write it in all three, or leave it unset to use the default.

One caution worth taking seriously: the facilitator will be reading a machine
translation aloud to a room that contains native speakers of the original. For a
routine meeting that's fine. For anything contentious — a grievance, a leadership
question, a complaint about the organisation — have a bilingual volunteer glance at
the original before it's read out. The prompt tells Gemini not to soften criticism,
but that's an instruction, not a guarantee.

## What the controls actually do

- **Per-device cooldown, 5 minutes.** Stops double-taps and casual repeat posting.
  It is beatable by re-scanning in incognito — but only by someone sitting in the
  room looking at the screen, since the entry token is short-lived.
- **Room-wide cap, 15 questions a minute.** Identity-free flood protection. Excess
  submissions get a "try again in a moment" message rather than being dropped.
- **Pause submissions.** Manual kill switch for the facilitator.
- **Clustering.** The real spam defense. Twenty questions from one person collapse
  into one topic card the facilitator dismisses once.

Nothing here is a per-person limit, because an anonymous QR entrance cannot
establish who a person is. Treat the cooldown as friction, not enforcement.

## Config

Everything tunable is in the `CONFIG` object at the top of `Code.gs`:
cooldown length, room cap, QR rotation interval, character limit, model. Set
`requireEntryToken: false` if you would rather print the QR on a flyer and drop
the room scoping.

## Before you go live

Load-test it. An anonymous web app runs every request as the owner, and Apps Script
caps simultaneous executions, so a full room submitting at once is the failure mode
to rule out — not the daily quotas, which you will not come near. Open the participant
URL on a dozen phones and have everyone submit on a count of three.

Worth knowing: `gemini-3.5-flash` is current as of now, but Google retires model IDs
on a schedule. If clustering silently stops working months from now, check the
execution log for a 404 and update `CONFIG.model`.
