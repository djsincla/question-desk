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
 * A room screen served by the WordPress plugin is accepted the same way:
 *   https://<any site>/questions/?view=present&s=<session>&r=<key>
 * It needs no guest page (no Google sign-in is involved), so its slide address is
 * simply the same page with the QR-only layout.
 *
 * Any other web page can be shown too (webPage): paste any link — with or without its
 * https:// — and the add-in frames it as it is, sandboxed, with none of the Question Desk
 * handling. Slides can only show secure pages, so an http:// link is tried as https://.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomUrl = factory();
})(this, function () {
  var PATTERN = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/?#]+\/s\/|a\/[^\/?#]+\/macros\/s\/|macros\/s\/)([A-Za-z0-9_-]+)\/exec(?:\?([^#]*))?(?:#.*)?$/;

  // A guest page link (docs/join): https://<any site>/…?d=<deployment>&view=present&s=<session>
  // and, without a d=, a room screen served by the WordPress plugin.
  var GUEST = /^https:\/\/[^\s?#]+\?([^#]*)$/;

  /**
   * A link as pasted, with its scheme filled in: people copy "www.apnews.com" from a browser's
   * address bar as often as the full address. A slide can only show secure pages, so http://
   * becomes https://, and anything that isn't a web link at all (javascript:, data:, file:)
   * or isn't shaped like a host is refused here.
   */
  function withScheme(text) {
    if (/^https:\/\//i.test(text)) return text;
    if (/^http:\/\//i.test(text)) return 'https://' + text.slice(7);
    // Another scheme (javascript:, data:, file:, mailto:) is never shown. Digits after the
    // colon mean a port, as in example.org:8443, not a scheme.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return '';
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+([:\/?#]|$)/i.test(text) ? 'https://' + text : '';
  }

  function parse(input) {
    // Links pasted from Outlook or Teams can carry &amp;; a #fragment is never part of the link.
    var text = withScheme(String(input || '').trim().replace(/&amp;/g, '&').replace(/#.*$/, ''));
    if (!text) return null;
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
      if (!sid || !key) return null;
      if (d) return { deployment: d[1], session: sid[1], key: key[1], guestPage: base };
      // A guest page link whose deployment is malformed stays refused, rather than passing
      // for a WordPress one.
      if (/(?:^|&)d=/.test(guest[1])) return null;
      // No deployment at all: the WordPress plugin serves the room screen from the site itself.
      return /(?:^|&)view=present(?:&|$)/.test(guest[1]) ? { site: base, session: sid[1], key: key[1] } : null;
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
    if (parsed.site) return parsed.site + '?' + slideQuery(parsed);
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
    if (!parsed) return null;
    // A WordPress room screen has no second address to fall back to: it is the site itself.
    if (parsed.site) return parsed.site + '?' + slideQuery(parsed);
    return 'https://script.google.com/macros/s/' + parsed.deployment + '/exec?' + slideQuery(parsed);
  }

  function slideQuery(parsed) {
    return 'view=present&s=' + parsed.session + '&r=' + parsed.key + '&layout=qr';
  }

  /** Only Question Desk's own pages (served from Google) may tell the add-in to reload. */
  function fromGoogle(origin) {
    return /^https:\/\/(script\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/.test(String(origin || ''));
  }

  /**
   * Whether a message may come from the screen now on the slide: Google's own pages, or —
   * for a WordPress room screen — that site itself. Anything else is ignored.
   */
  function fromScreen(origin, link) {
    if (fromGoogle(origin)) return true;
    var parsed = parse(link);
    if (!parsed || !parsed.site) return false;
    var host = /^(https:\/\/[^\/?#]+)/.exec(parsed.site);
    return !!host && String(origin || '') === host[1];
  }

  /**
   * Any other web page for the slide: a link with a host, no user name or password in it, no
   * spaces, within a sensible length — with or without https:// in front. Returns it tidied,
   * or null.
   */
  function webPage(input) {
    var text = String(input || '').trim();
    if (!text || text.length > 2000 || /\s/.test(text)) return null;
    text = withScheme(text);
    if (!text) return null;
    // No URL parser needed (older PowerPoint browsers): scheme, host, optional port, then anything.
    var match = /^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?([\/?#].*)?$/i.exec(text);
    if (!match) return null;
    return 'https://' + match[1].toLowerCase() + (match[2] || '') + (match[3] || '/');
  }

  /** Why a link can't be shown, for the setup form. */
  function problem(input) {
    var text = String(input || '').trim();
    if (!text) return 'Paste a link.';
    if (/^https?:\/\/[^\/?#]*@/i.test(text)) return 'Links with a user name or password in them can’t be shown.';
    if (/\s/.test(text)) return 'That link has a space in it. Copy the whole address from your browser.';
    return 'That isn’t a web address. Paste a link like apnews.com or https://apnews.com.';
  }

  return { parse: parse, forSlide: forSlide, direct: direct, fromGoogle: fromGoogle, fromScreen: fromScreen,
           webPage: webPage, problem: problem };
});
