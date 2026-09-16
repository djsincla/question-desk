# Question Desk for WordPress

Anonymous, multilingual audience questions for live events, as a WordPress plugin: people ask
from their phones, a QA Facilitator sees the questions grouped by topic and translated, and the
room sees what is being answered.

This is the same Question Desk as the Google Apps Script version, with the same pages. **Both
versions are supported.** Run whichever suits the event — an organization already inside Google
Workspace, or one that would rather keep everything on its own site — or run both. Pages, the
text catalog and the sessions CSV are shared, so they behave the same and files move between
them.

## What you need

- WordPress 6.4 or newer, PHP 8.1 or newer, MySQL 5.7+ / MariaDB 10.4+
- A Gemini API key for grouping and translation ([aistudio.google.com](https://aistudio.google.com/apikey)).
  Without one, questions still arrive and can be answered — they are simply not grouped or
  translated.
- Mail that actually leaves the server: use an SMTP plugin. PHP's `mail()` is dropped by many
  hosts, and summary emails would vanish.

## Install

1. Download `question-desk-<version>.zip` from the repository's releases.
2. WordPress admin → **Plugins → Add New → Upload Plugin** → choose the zip → **Install Now** →
   **Activate**.
3. Open **Question Desk** in the admin menu. It creates its tables, the **QA Facilitator** and
   **Question Desk Admin** roles, and the `/questions/` pages on activation.

If `/questions/` shows "not found", save **Settings → Permalinks** once (WordPress needs to
write its rewrite rules), or use `/?qd_page=1`.

### The Gemini key

Either paste it under **Question Desk → Health & testing → Gemini**, or — better on a shared
host — put it in `wp-config.php`, where it is never shown in the admin area:

```php
define( 'QD_GEMINI_API_KEY', 'your-key' );
```

### Grouping every minute

Grouping and the schedule run on WP-Cron, which only fires when the site gets traffic. A queue
that is open counts as traffic, so an event with a facilitator watching keeps grouping on its
own. For a site that is quiet between events, a real cron on the host is steadier:

```
* * * * * curl -s https://example.org/wp-cron.php?doing_wp_cron > /dev/null
```

with `define( 'DISABLE_WP_CRON', true );` in `wp-config.php`.

## Running an event

- **Question Desk → Sessions**: make an event and its sessions, choose how people join (a
  rotating QR code in the room, or a shareable link), and copy the links.
- **Room screen** goes on the projector. It needs no sign-in — the link carries its own key.
- **PowerPoint slide**: the same link with the QR-only layout, for the
  [Question Desk QR add-in](../docs/addin/README.md), which accepts this version's links too.
- **QA Facilitator queue**: `/questions/?view=moderate&s=…`, for signed-in facilitators.
- People are WordPress users. Administrators manage everything; **Question Desk Admin** manages
  it without being a site administrator; **QA Facilitator** runs the queues they are assigned to.

## Keeping the two versions together

- **Sessions** move either way through the sessions CSV: export from one, import into the other
  (**Sessions → Import**). The columns are generated from the same source in both.
- **Questions** from an event run on the Apps Script version can be kept here too:
  **Question Desk → Import questions** takes the CSV attached to a summary email. Importing the
  same file twice changes nothing, and nothing is moved or deleted from the other version.

## Hosting notes

- **Never cache the REST API or the room screen.** A page cache that serves a stale room screen
  hands out a dead join code. The plugin sends `Cache-Control: no-store` on its server calls;
  managed hosts and Cloudflare may need a rule for `/questions/` and `/wp-json/question-desk/`.
- **Framing**: the room screen and slide must be showable inside the PowerPoint add-in. Hosts
  and security plugins that add `X-Frame-Options` to every page will block that.
- 100 phones polling every few seconds are real PHP requests. Try a load test first:
  **Health & testing → Start load test** prints the command.

## Working on the plugin

See [WORDPRESS.md](../WORDPRESS.md) for the port's plan and status, and for the development
commands (`npm run wp:start`, `wp:test`, `wp:browsers`, `wp:package`).
