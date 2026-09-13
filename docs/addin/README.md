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

These install the add-in for **your account on one computer**. To give it to everyone in
your organization at once, see *For everyone in your organization* below.

### Mac

**Easiest — Terminal** (Applications → Utilities → Terminal), paste and press Return:

```bash
curl -fsSL https://djsincla.github.io/question-desk/addin/install/install-mac.sh | bash
```

**Or download** [QuestionDeskQR-Mac.zip](https://djsincla.github.io/question-desk/addin/install/QuestionDeskQR-Mac.zip),
open it, and double-click **Install Question Desk QR.command**.
macOS will say it can't verify the app, because it isn't from the App Store. Click
**Done**, then open **System Settings → Privacy & Security**, scroll down, click
**Open Anyway** next to *Install Question Desk QR*, and confirm.

Then quit PowerPoint (⌘Q), reopen it, open a presentation, and choose
**Home → Add-ins → Question Desk QR**.

To remove it: `curl -fsSL https://djsincla.github.io/question-desk/addin/install/uninstall-mac.sh | bash`,
or double-click **Uninstall Question Desk QR.command**.

### Windows

1. Download [QuestionDeskQR-Windows.zip](https://djsincla.github.io/question-desk/addin/install/QuestionDeskQR-Windows.zip).
2. Right-click the zip → **Properties** → tick **Unblock** (if shown) → **OK**. Then
   right-click → **Extract All**.
3. Double-click **Install Question Desk QR.cmd**. If Windows shows *Windows protected
   your PC*, click **More info → Run anyway**.
4. Close and reopen PowerPoint, open a presentation, and choose **Home → Add-ins**
   (or **Insert → My Add-ins**) → **Question Desk QR**.

No administrator rights are needed; it installs for your Windows account only. To remove
it, double-click **Uninstall Question Desk QR.cmd**.

Run the installer again at any time to update to the latest version.

### What the installers do

- **Mac:** saves the add-in's manifest to
  `~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/`, replacing any older
  copy of this add-in.
- **Windows:** saves the manifest to `%LOCALAPPDATA%\QuestionDeskQR\` and adds one
  registry value under `HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Wef\Developer`.
  This is the same registration Microsoft's own add-in tools use.

Both download the manifest from this site, check that it's the Question Desk QR add-in,
and change nothing else. The scripts are in [`docs/addin/install`](install/).

### For everyone in your organization (recommended for many computers)

A Microsoft 365 administrator deploys it once, and it appears in PowerPoint on Windows,
Mac and the web for the people it's assigned to.

1. Microsoft 365 admin center → **Settings → Integrated apps → Upload custom apps**.
2. Choose **Office Add-in**, then **Provide link to the manifest file** and paste
   `https://djsincla.github.io/question-desk/addin/manifest.xml`.
3. Assign it to the people who build slides, and deploy.
4. It can take up to a day to appear under **Home → Add-ins → Admin Managed**.

<details>
<summary>Installing by hand, without the installers</summary>

**Mac:** download [`manifest.xml`](https://djsincla.github.io/question-desk/addin/manifest.xml)
and copy it (don't move a file you want to keep) into
`~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/` — in Finder,
**Go → Go to Folder…**. Create `wef` if it doesn't exist. Restart PowerPoint.

**Windows:** put `manifest.xml` in a shared folder, add its network path under
**File → Options → Trust Center → Trust Center Settings → Trusted Add-in Catalogs**, tick
**Show in Menu**, restart PowerPoint, then **Insert → My Add-ins → Shared Folder**.

**PowerPoint on the web:** **Insert → Add-ins → My Add-ins → Upload My Add-in**.
</details>

**If an old version still shows** (for example the box is small) after updating: quit
PowerPoint, run the installer again, reopen PowerPoint and insert the add-in on the slide
again. Existing boxes keep the size they were inserted at; drag their handles to resize.

## Use it

1. Question Desk Admin page → **Sessions → Links** → copy **PowerPoint slide**.
   (The room screen link works too.)
2. On your slide: **Insert → My Add-ins → Question Desk QR**. Paste the link and press
   **Show on slide**.
3. The box fills a standard widescreen slide when inserted; drag its handles to resize it
   (for example, to leave room for your own title). Start the slideshow: the code updates on its own.
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
