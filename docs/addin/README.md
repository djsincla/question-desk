# Question Desk QR — PowerPoint add-in

Puts a Question Desk session's **live QR code** on a PowerPoint slide. The code keeps
rotating during the slideshow, exactly like the room screen, so people scan it from the
slide instead of a separate screen. Works in PowerPoint for Windows, Mac and the web.

- Free, no account, nothing to run: the add-in is two files served from this repository's
  GitHub Pages site.
- The session link is saved inside the presentation, so the slide works on any computer
  that has the add-in installed.
- The slide shows a QR-only view by default. A checkbox shows the full room screen
  (heading, instructions and *Now answering*) instead.

Manifest: <https://djsincla.github.io/question-desk/addin/manifest.xml>

## Install

Menu names differ a little between PowerPoint versions.

### For everyone in your organization (recommended)

A Microsoft 365 administrator deploys it once, and it appears in PowerPoint on Windows,
Mac and the web for the people it's assigned to.

1. Microsoft 365 admin center → **Settings → Integrated apps → Upload custom apps**.
2. Choose **Office Add-in**, then **Provide link to the manifest file** and paste the
   manifest link above.
3. Assign it to the people who build slides, and deploy.
4. It can take up to a day to appear. In PowerPoint: **Insert → Add-ins** (or **Get Add-ins**)
   → **Admin Managed** → **Question Desk QR**.

### On one Mac, to try it

1. Download [`manifest.xml`](https://djsincla.github.io/question-desk/addin/manifest.xml).
2. In Finder, **Go → Go to Folder…** and open
   `~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/`. Create a folder named
   `wef` if there isn't one, and put `manifest.xml` in it.
3. Quit and reopen PowerPoint. **Insert → Add-ins → My Add-ins** — Question Desk QR is
   listed under developer add-ins.

### On one Windows PC, to try it

1. Make a folder (for example `C:\QuestionDeskAddin`), put `manifest.xml` in it, and share
   the folder (right-click → Properties → Sharing). Note its network path, such as
   `\\YOUR-PC\QuestionDeskAddin`.
2. PowerPoint → **File → Options → Trust Center → Trust Center Settings → Trusted Add-in
   Catalogs**. Add the network path, tick **Show in Menu**, OK.
3. Restart PowerPoint. **Insert → My Add-ins → Shared Folder → Question Desk QR**.

### PowerPoint for the web, to try it

**Insert → Add-ins → My Add-ins → Upload My Add-in**, and choose `manifest.xml`.

## Use it

1. Question Desk Admin page → **Sessions → Links** → copy **PowerPoint slide**.
   (The room screen link works too.)
2. On your slide: **Insert → My Add-ins → Question Desk QR**. Paste the link and press
   **Show on slide**.
3. Move and resize the box. Start the slideshow: the code updates on its own.
4. To change the session, click **Change session** in the top corner while editing.
   It never shows during the slideshow.

## Before an event

- **Test on the computer that will present**, in slideshow mode, and scan the code with a
  phone on mobile data. PowerPoint's built-in browser differs between Windows and Mac.
- The slide needs internet for the whole event; if the connection drops, the code stops
  rotating and new people can't join an in-room session.
- The link is the public room screen address, so it never asks anyone to sign in.

## How it works

`index.html` is the add-in page. It keeps the pasted link in the presentation's settings
and shows the room screen (`…/exec?view=present&s=<session>&layout=qr`) in a frame.
`room-url.js` accepts only Question Desk session links and always converts them to the
public `/macros/s/` address. Tests: `tests/addin.test.js`.
