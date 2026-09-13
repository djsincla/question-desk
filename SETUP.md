# Question Desk — setup

Anonymous audience Q&A running entirely inside your Workspace account. Participants
scan a QR code on the room screen, submit a question, and the facilitator sees them
grouped into topics by Gemini instead of as one long undifferentiated list.

## What you need

- A Workspace account that can publish an Apps Script web app to "Anyone"
  (check with your admin first — some tenants block this)
- A Gemini API key from Google AI Studio

## Install

1. Push the code with clasp (see "Working on this locally" below). Pasting files into
   the editor also works: `Code.gs` (from `Code.js`), `Ask.html`, `Present.html`,
   `Moderate.html`, `Admin.html`, `Denied.html`, and `appsscript.json`.
2. Open **Project Settings → Script Properties** and add `GEMINI_API_KEY` — your AI
   Studio key. Everything else is managed on the Admin page.
3. Run `setUp()` once from the editor. Approve the permission prompts, including
   "send email as you". It creates the submissions spreadsheet, installs the
   clustering trigger, and moves any questions from an older single-session install
   into a session called "First session". Run it again whenever an update adds a
   permission.
4. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the deployment URL and open `…/exec?view=admin`, signed in as the script owner.

## Admin page

- **People** — add administrators and QA Facilitators, and choose who receives session
  summary emails by default. Both must be accounts in your
  Workspace domain: Google does not tell the app who is signed in from any other
  domain, so an outside QA Facilitator would always be turned away.
- **Events** — **New event** groups the sessions held at one event (a conference with
  several rooms, a partner night). Sessions are listed under their event; **Add session**
  creates one in it, and a session's **Event** field moves it. An event can have its own
  branding — organization name, accent, welcome text, footer, room screen backgrounds and
  logo — which overrides the site's for its sessions; a session can still override the
  name, accent and logo. Blank fields inherit. Deleting an event keeps its sessions (they
  move to *Not in an event*). Use ▲ ▼ on an event to reorder events.
- **Export CSV / Import CSV** — export every session's settings to a CSV, edit it in
  Google Sheets or Excel, and import it (or a new file) back. **Check file** shows what each
  row will do before anything is saved. A row matches an existing session by name plus
  scheduled start and end, or by name alone when it has no times; choose whether matches are
  updated or left alone. Only the *Session* column is required: columns left out keep their
  settings. Times use the app's time zone (`2026-10-03 18:30` or `10/3/2026 6:30 PM`). QA
  Facilitators must already be on the People tab. Ended sessions are never changed.
- **Archive** — ended sessions move to *Archived sessions* 30 days after ending (or right
  away with **Archive**), which keeps the app's settings storage small. Their questions
  stay in the spreadsheet; **Restore** brings one back, for example to email its summary.
- **Sessions** — create a session, choose how people join, pick its QA Facilitators, and
  decide whether its summary is emailed when it ends. Activate it when doors open;
  deactivate to pause it between days; **End session** when it is over for good.
  Optionally schedule it to start and end on its own (checked every minute), and give
  it its own organization name, accent color and logo for a partner event. Sessions
  that are not running can be deleted with all their questions. Ending or deleting asks
  you to type the session's name. Drag sessions (or use ▲ ▼) to set their order within
  their event. **Prepared questions** (one per line) are loaded ahead of time
  and appear in the QA Facilitator's queue under *Prepared questions*, where each can be
  added to the live queue when it's useful.
  - **In-room QR** — the room screen code changes every 150 seconds. Only people who
    can see the screen can ask. The room screen and slide links carry their own key;
    **Replace room screen link** retires a leaked one (re-copy it into slides).
  - **Shareable link** — a fixed link and QR you can email or print. Anyone with the
    link can ask. **Replace participant link** cuts off copies that have spread.
- **Email links** sends the participant link (link sessions) or room screen / queue
  links to anyone; each recipient gets their own email. **Email QA Facilitators** sends the
  room screen and queue links to the session's QA Facilitators.
- **Branding** — organization name, logo (resized in the browser before upload),
  accent color, welcome text, footer, room screen background colors, tab icon (a link
  to an image on your website), and the app address used in QR codes and emails.
- **Health & testing** — run a health check (Gemini key and model, trigger, sheet,
  email quota, app address) and start or finish a load test. Admins are emailed
  automatically if question grouping fails three minutes in a row, and again when it
  recovers.
- The header shows the running **version** with a link to its release notes.

The app's main address (`…/exec` with nothing after it) is a branded landing page:
your logo, welcome text and "scan the code in the room". Signed-in staff also see
their open sessions and, for administrators, a link to the Admin page.

## Running an event

Open the session's **Links** on the Admin page:

| View | URL | Who opens it |
|---|---|---|
| Room screen | `…/exec?view=present&s=<session>` | Projector — no sign-in needed, any browser |
| Facilitator queue | `…/exec?view=moderate&s=<session>` | QA Facilitator, signed in |
| Participant page | the QR on the room screen, or the shareable link | Audience |

Put the room screen up before doors open. It follows the session live: it shows the
code when the session is active, "Questions open soon" when it isn't, and switches
light/dark if an admin changes the theme. Press **T** on the room screen to flip the
theme locally if the projector washes out.

**Showing the code in PowerPoint:** install the free *Question Desk QR* add-in
(`docs/addin/README.md`) and paste the session's **PowerPoint slide** link. The QR code
keeps rotating during the slideshow.

Several sessions can run at once (breakout rooms); each has its own code, queue,
cooldown and question cap.

When a session ends, a final grouping pass translates anything still waiting, and —
if the session asks for it — the summary is emailed with topics, merged questions, and
every question in its original wording next to the English translation, plus a CSV.
By default it goes to the session's QA Facilitators; set different default recipients on
the People tab, or custom recipients on a session's form. Ended sessions can
be re-sent from the Admin page with **Email summary**.

Questions land in the sheet within a second. The trigger clusters them every minute,
or hit **Group now** to force it. **Merge into one question** asks Gemini to collapse
a topic into a single question to read aloud — that is the part that saves the
facilitator the most time.

**Now answering** on a topic puts it on the room screen and at the top of everyone's
phone, in English, Korean and Spanish, with the merged question if there is one.
Press it again (**Stop showing**) to clear it.

Participants who have joined also see the topics a QA Facilitator has approved with
**Show on phones** — the short topic labels, never anyone's actual question — in their
own language, and can tap **Me too** on any of them. Nothing appears on phones until a
QA Facilitator approves it, and **Hide from phones** removes it again. The queue shows "+N me too" per topic and sorts by questions plus
support, so the facilitator sees what the room most wants answered.

## Working on this locally instead

The editor at script.google.com is fine for a one-off. If you expect to keep
changing this between events, use `clasp` and keep the project in git.

```bash
npm install -g @google/clasp
clasp login
```

You also need to switch on the Apps Script API once, at
script.google.com/home/usersettings — clasp fails with a confusing error if you skip it.

Then either point this folder at what you already deployed:

```bash
cp .clasp.json.example .clasp.json   # set scriptId (Project Settings in the editor)
```

or create a new project from this folder:

```bash
clasp create-script --type standalone --title "Question Desk"
git checkout appsscript.json         # clasp create overwrites the manifest
clasp push --force
```

For releases, copy `.deploy.env.example` to `.deploy.env` and set the web app's
deployment ID (Deploy → Manage deployments) and, if you use named clasp logins, the
account name. Both `.clasp.json` and `.deploy.env` are git-ignored; they identify your
install and never belong in the repository.

Gotchas:

- Server code is `Code.js` locally. clasp uploads it as `.gs`; the HTML files keep
  their extension. `.claspignore` is an allowlist — add any new page to it.
- `clasp push` **overwrites** the remote project, and `clasp pull` overwrites your
  local files. There is no merge. Local, in git, is the source of truth — never edit
  in the web editor.
- `clasp create` replaces `appsscript.json` with a default that drops the web app and
  scope settings. Restore it from git before the first push.
- A push only updates the project's draft (HEAD). The live URL serves a pinned
  version until the deployment is updated.

### Tests and shipping

```bash
node --test tests/*.test.js          # ~180 functional tests, about a second
npm run test:browsers                # WebKit + Chromium page tests (npm install first)
node scripts/check-secrets.js        # keys, IDs and real email addresses
scripts/ship.sh "what changed"       # scan → tests → push → version → redeploy → tag → GitHub release
```

Before shipping, bump `APP.version` at the top of `Code.js` and add a dated section to
`CHANGELOG.md`; `ship.sh` refuses a version that has already been released and uses
that section as the GitHub release notes the Admin page links to.

The tests run the real `Code.js` against fake Apps Script services, so roles,
sessions, tokens, limits, clustering, emails and the setup migration are checked
without deploying. A git pre-commit hook runs them automatically. They can't check
real concurrency or how pages look on a phone — still do a scan on mobile data after
every ship.

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

Topic labels are always written in the QA Facilitator's language regardless of the
question's language. This is deliberate: it's what lets a Korean question and a
Spanish question about the same thing land in the same group instead of forming two
parallel topics that never meet. Set `CONFIG.moderatorLanguage` if English isn't
your facilitator's working language.

A session's participant heading is a single string, so it appears in whatever
language you write it. Either write it in all three, or leave it blank to use the
default.

One caution worth taking seriously: the facilitator will be reading a machine
translation aloud to a room that contains native speakers of the original. For a
routine meeting that's fine. For anything contentious — a grievance, a leadership
question, a complaint about the organisation — have a bilingual volunteer glance at
the original before it's read out. The prompt tells Gemini not to soften criticism,
but that's an instruction, not a guarantee.

## What the controls actually do

- **Time between questions, per phone.** 5 minutes by default; each session can set 0 to
  60 minutes on its form, and a change applies at once, even to phones already waiting.
  Stops double-taps and casual repeat posting. It is beatable by re-scanning in a
  private window — for in-room sessions, only by someone who can see the room screen.
- **Per-session cap, 15 questions a minute.** Identity-free flood protection. Excess
  submissions get a "try again in a moment" message rather than being dropped.
- **Question length.** 300 characters by default, adjustable per session up to 1024.
  Oversized submissions are rejected before the server does any work on them.
- **Pause submissions.** Manual kill switch for the QA Facilitator.
- **Clustering.** The real spam defense. Twenty questions from one person collapse
  into one topic card the QA Facilitator dismisses once.

Nothing here is a per-person limit, because an anonymous QR entrance cannot
establish who a person is. Treat the wait between questions as friction, not enforcement.

## Config

Everything tunable is in the `CONFIG` object at the top of `Code.js`:
cooldown length, per-session question cap, QR rotation interval, default and maximum
question length (300 and 1024), model. Per-session choices — how people join, screen
theme, question length — are set on the Admin page. For a flyer QR, create the
session as a shareable link.

## Troubleshooting

### "Sorry, unable to open the file at this time"

**What people see:** a Google Drive page that says *"Sorry, unable to open the file at this
time. Please check the address and try again."* instead of the questions page or room
screen. It often happens on phones, and the same link works in a private window.

**Why it happens:** the browser is **signed into more than one Google account** (for example
a personal Gmail account and an organization account). When the browser opens a
`script.google.com` address, it automatically sends Google all of those sign-ins; Google
can't decide which account to use and shows its error page **before Question Desk's code
runs**. Google documents that multiple sign-in "isn't supported for Apps Script, add-ons, or
web apps". Nothing in Question Desk's code, links or Apps Script settings can prevent it —
the problem happens in the request the browser makes, not in the page.

**How to confirm it's this:** open the same link in a private browsing window. If it works
there, it's this problem.

#### The fix: turn on the guest page

The guest page is a small page on another website that shows the Question Desk page inside
it. Because the Question Desk page is then *embedded* from another site, browsers that block
third-party cookies send Google **no sign-in at all**, so Google treats everyone as an
anonymous visitor and can't show the error.

1. **Host the guest page.** Use this project's copy, already live at
   `https://djsincla.github.io/question-desk/join/`, or copy the two files in
   [`docs/join`](docs/join/README.md) (`index.html` and `join-url.js`) to a folder on your own
   website, for example `https://autismla.org/questions/`.
2. **Admin page → Branding → Guest page address:** enter that folder's address, for example
   `https://djsincla.github.io/question-desk/join/`. Save branding.
   - Don't use **Advanced → Question Desk Google address** for this. Leave it blank; it's only
     for Question Desk's own `https://script.google.com/macros/s/…/exec` address.
3. **For each session:** Sessions → **Edit** → **Use the guest page for** → tick
   **Room screen**, **PowerPoint slide**, or both → **Save session**. Each box controls the QR
   code shown there. (A session can use a different guest page address, such as a partner's
   website, in the field that appears. Blank uses the Branding address, or this project's
   copy if that is blank too.)
4. **Use the new links.** Sessions → **Links** now shows guest page addresses for the room
   screen and the questions link, and the room screen's QR code points through the guest
   page. Re-copy any links you saved or emailed before, and reload open room screens.
5. **Test** in the browser that showed the error: open the room screen link and scan the QR
   code with a phone that showed it.

**What changes and what doesn't**

| Page | Opens through |
|---|---|
| QR code on the room screen | Guest page when **Room screen** is ticked |
| Room screen link | Guest page when **Room screen** is ticked |
| QR code on the PowerPoint slide | Guest page when **PowerPoint slide** is ticked |
| Shareable questions link (and emailed links) | Guest page when either box is ticked |
| PowerPoint slide itself (add-in) | Directly — the add-in already embeds from outside Google |
| QA Facilitator queue, Admin page | Directly on Google — staff sign in with the organization account |

**Which browsers the guest page fixes**

| Browser | Signed into several Google accounts |
|---|---|
| Safari (iPhone, iPad, Mac) | Fixed — blocks third-party cookies by default |
| Firefox | Fixed — blocks third-party cookies by default |
| Chrome, Edge, Samsung Internet | May still show the error — these still send third-party cookies by default |

For anyone still affected (usually Chrome): the room screen tells guests, in English, Korean
and Spanish, to try a private browsing window.

#### Other things to know

- **Projector computer:** open the room screen in a private window, or in a browser profile
  with no Google account signed in.
- **QA Facilitators and administrators:** the queue and Admin page need the organization
  sign-in. Use a browser or Chrome profile signed into only the organization account, or
  sign in to just that account in a private window.
- **Old links:** always copy links from Sessions → Links. Links from an archived deployment
  show the same Google error.
- **Your own website:** if it sends a `Content-Security-Policy` header, allow
  `frame-src https://script.google.com https://*.googleusercontent.com`.

## Before you go live

Load-test it. An anonymous web app runs every request as the owner, and Apps Script
caps simultaneous executions, so a full room submitting at once is the failure mode
to rule out — not the daily quotas, which you will not come near.

1. Admin page → **Health & testing** → **Start load test**. It creates a throwaway
   session and switches on a keyed test endpoint for one hour.
2. Copy the command it shows and run it from this folder, with `--count` set to your
   largest room:
   `node scripts/loadtest.js --url "https://script.google.com/macros/s/…/exec" --key … --count 60`
3. Read the report: every submission should be `ok`. `busy` means requests queued more
   than 10 seconds; HTTP or network errors mean Apps Script refused concurrent
   executions.
4. **Finish and delete test data.**

Then do the human version: a dozen phones on mobile data, everyone submits on a count
of three.

Worth knowing: `gemini-3.5-flash` is current as of now, but Google retires model IDs
on a schedule. If clustering silently stops working months from now, check the
execution log for a 404 and update `CONFIG.model`.
