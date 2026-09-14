/**
 * Turns whatever Question Desk link someone pastes into the address a slide
 * should show. Shared by the add-in page and the Node tests.
 *
 * Accepts room screen, queue or participant links in any form Google uses:
 *   https://script.google.com/macros/s/<id>/exec?...
 *   https://script.google.com/a/macros/<domain>/s/<id>/exec?...
 *   https://script.google.com/a/<domain>/macros/s/<id>/exec?...
 * and returns the public /macros/s/ form, because PowerPoint's built-in browser
 * can't sign in to Google — or, for a guest page link, the same guest page (the
 * session chose it for the slide).
 *
 * Any other https web page can be shown too (webPage): the add-in frames it as it is,
 * sandboxed, with none of the Question Desk handling.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomUrl = factory();
})(this, function () {
  var PATTERN = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/?#]+\/s\/|a\/[^\/?#]+\/macros\/s\/|macros\/s\/)([A-Za-z0-9_-]+)\/exec(?:\?([^#]*))?(?:#.*)?$/;

  // A guest page link (docs/join): https://<any site>/…?d=<deployment>&view=present&s=<session>
  var GUEST = /^https:\/\/[^\s?#]+\?([^#]*)$/;

  function parse(input) {
    // Links pasted from Outlook or Teams can carry &amp;; a #fragment is never part of the link.
    var text = String(input || '').trim().replace(/&amp;/g, '&').replace(/#.*$/, '');
    var match = text.match(PATTERN);
    if (!match) {
      var guest = text.match(GUEST);
      var d = guest && /(?:^|&)d=(AKfycb[A-Za-z0-9_-]{20,120})(?:&|$)/.exec(guest[1]);
      var sid = guest && /(?:^|&)s=([a-f0-9]{8})(?:&|$)/.exec(guest[1]);
      var key = guest && /(?:^|&)r=([a-f0-9]{16})(?:&|$)/.exec(guest[1]);
      // The guest page's own address (e.g. https://djsincla.github.io/question-desk/join/),
      // kept so the slide shows the room screen through it.
      var base = text.split('?')[0];
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~%\/-]*)?$/i.test(base)) return null;
      return d && sid && key ? { deployment: d[1], session: sid[1], key: key[1], guestPage: base } : null;
    }
    var params = {};
    (match[2] || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      try {
        params[decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))] = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
      } catch (err) { /* ignore malformed pairs */ }
    });
    if (!/^[a-f0-9]{8}$/.test(params.s || '')) return null;
    // Room screen and slide links carry their own key (r); a participant link has none.
    if (!/^[a-f0-9]{16}$/.test(params.r || '')) return null;
    return { deployment: match[1], session: params.s, key: params.r };
  }

  /** Room screen address for a slide: always the QR-only layout (a big code, no logo). */
  function forSlide(input) {
    var parsed = parse(input);
    if (!parsed) return null;
    // A guest page link stays a guest page link: the presenting laptop may be signed into
    // several Google accounts, and the guest page keeps Google from refusing the page.
    if (parsed.guestPage) return parsed.guestPage + '?d=' + parsed.deployment + '&' + slideQuery(parsed);
    return direct(input);
  }

  /**
   * The same slide straight from Google, without the guest page. The add-in falls back to it
   * when a guest page never loads: many sites (autismla.org among them) refuse to be shown
   * inside another page, and PowerPoint's own browser isn't signed into Google anyway.
   */
  function direct(input) {
    var parsed = parse(input);
    return parsed ? 'https://script.google.com/macros/s/' + parsed.deployment + '/exec?' + slideQuery(parsed) : null;
  }

  function slideQuery(parsed) {
    return 'view=present&s=' + parsed.session + '&r=' + parsed.key + '&layout=qr';
  }

  /** Only Question Desk's own pages (served from Google) may tell the add-in to reload. */
  function fromGoogle(origin) {
    return /^https:\/\/(script\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/.test(String(origin || ''));
  }

  /**
   * Any other web page for the slide: an https address with a host, no user name or password
   * in it, no spaces, within a sensible length. Returns it tidied, or null.
   */
  function webPage(input) {
    var text = String(input || '').trim();
    if (!text || text.length > 2000 || /\s/.test(text)) return null;
    // No URL parser needed (older PowerPoint browsers): scheme, host, optional port, then anything.
    var match = /^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?([\/?#].*)?$/i.exec(text);
    if (!match) return null;
    return 'https://' + match[1].toLowerCase() + (match[2] || '') + (match[3] || '/');
  }

  /** Why a link can't be shown, for the setup form. */
  function problem(input) {
    var text = String(input || '').trim();
    if (!text) return 'Paste a link.';
    if (/^http:\/\//i.test(text)) return 'That link starts with http://. PowerPoint only shows secure pages: use the https:// address.';
    if (/^https:\/\/[^\/?#]*@/i.test(text)) return 'Links with a user name or password in them can’t be shown.';
    return 'That isn’t a web address. Paste a link that starts with https://.';
  }

  return { parse: parse, forSlide: forSlide, direct: direct, fromGoogle: fromGoogle, webPage: webPage, problem: problem };
});
