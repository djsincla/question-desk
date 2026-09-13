# Question Desk guest page

Google refuses to open Apps Script pages for browsers signed into **more than one Google
account** — people see *"Sorry, unable to open the file at this time"*, and Question
Desk's code never runs. Google documents that multiple sign-in isn't supported for web apps.

The guest page works around it. It is a tiny page on **your own website** that shows the
Question Desk questions page or room screen inside it. Browsers that block third-party
cookies — **Safari (every iPhone and Mac) and Firefox**, by default — then send Google no
sign-in at all, so Google treats everyone as an anonymous visitor and the error can't happen.

- **Chrome** still sends third-party cookies by default, so a Chrome browser signed into
  several Google accounts may still see the error. Guests using Safari or Firefox won't.
- The QA Facilitator queue and Admin page are not affected; staff sign in to those.
- Nothing about your data changes: questions still go straight to your Google account.

## Use it

1. Host the two files in this folder — `index.html` and `join-url.js` — anywhere on the web
   (see below). This project's copy is already live at
   `https://djsincla.github.io/question-desk/join/`.
2. Admin page → **Branding → Guest page address**: paste the address of that folder.
3. For each session that should use it: **Edit → Open guest pages through → Guest page**.
   Its QR codes, questions link, room screen link and emailed links now go through the
   guest page. A session can also use its own address (for example a partner's site).

One guest page serves every session; each link carries the session in its address.

## Host it on your own website (for example autismla.org)

Copy `index.html` and `join-url.js` into one folder on the site — for example so that
`https://autismla.org/questions/` shows `index.html` — and use that folder's address on the
Branding tab.

- **Files you can upload** (most hosting, WordPress with file access, GitHub Pages, Netlify):
  upload both files into a folder named `questions`.
- **Website builders that only allow pasted code** (Squarespace, Wix, Google Sites): these
  usually can't host plain files at a custom address. Use this project's GitHub Pages copy,
  or a free static host, and link to it from your site.
- The site must allow its pages to embed `https://script.google.com` in a frame. If your
  site sends a `Content-Security-Policy` header, it needs `frame-src https://script.google.com
  https://*.googleusercontent.com`.

## Test it

Open a room screen through the guest page — Admin page → Sessions → **Links** → Room
screen — in the browser that showed the error. You should see the room screen with its code.

## How it works

`index.html` reads its own address (`?d=<deployment>&s=<session>&t=<code>`, or `&k=<key>`,
or `view=present`) and frames the matching Question Desk page. `join-url.js` refuses
anything that isn't a Question Desk guest page on `script.google.com`, so the page can't be
used to show other sites. It sends no referrer. Tests: `tests/join.test.js`,
`tests/links.test.js`.
