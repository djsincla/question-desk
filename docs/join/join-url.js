/**
 * Builds the Question Desk address a join/room wrapper page embeds, from the wrapper's
 * own query string. Shared with the Node tests.
 *
 * Two kinds of Question Desk can be embedded:
 *
 *   Apps Script, named in the link by its deployment:
 *     ?d=<deployment id>&s=<session>&t=<room code>      participant page, in-room session
 *     ?d=<deployment id>&s=<session>&k=<link key>       participant page, shareable link
 *     ?d=<deployment id>&view=present&s=<session>&r=<key>   room screen (optionally &layout=qr)
 *
 *   WordPress, where the site is NOT in the link: the copy of this page hosted by the
 *   organization names it once, in <html data-site="https://example.org/questions/">, and links
 *   carry only the Question Desk parameters (?s=…&t=…). A link can therefore never make this
 *   page show some other website — which matters, because the framed page fills the window and
 *   the address bar keeps showing the wrapper's own.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JoinUrl = factory();
})(this, function () {
  var RULES = {
    d: /^AKfycb[A-Za-z0-9_-]{20,120}$/,
    s: /^[a-f0-9]{8}$/,
    t: /^[a-f0-9]{12}$/,
    k: /^[a-f0-9]{16}$/,
    r: /^[a-f0-9]{16}$/,
    view: /^(present|panel)$/,
    layout: /^qr$/,
    lang: /^(en|ko|es|zh|vi|tl|hy)$/
  };

  function parseQuery(search) {
    var out = {};
    // Links pasted from Outlook or Teams can carry &amp; and a #fragment.
    String(search || '').replace(/^\?/, '').replace(/#.*$/, '').replace(/&amp;/g, '&').split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      try {
        out[decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))] = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      } catch (err) { /* ignore malformed pairs */ }
    });
    return out;
  }

  /** The site a WordPress copy of this page embeds: https, no query or fragment. */
  function cleanSite(value) {
    var site = String(value || '').trim();
    if (!site || !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~%/-]*)?$/i.test(site) || site.length > 300) return '';
    return /\.html?$/i.test(site) ? site : site.replace(/\/?$/, '/');
  }

  /**
   * Returns the address to embed, or null if the wrapper's address isn't a valid guest link.
   * onlyDeployment (optional): a self-hosted copy locked to one Apps Script Question Desk.
   * site (optional): a self-hosted copy locked to one WordPress Question Desk (data-site).
   */
  function target(search, onlyDeployment, site) {
    var p = parseQuery(search);
    site = cleanSite(site);
    if (onlyDeployment && p.d !== onlyDeployment) return null;
    for (var name in p) {
      // Unknown names (fbclid, utm_source… added by social media and newsletters) are ignored:
      // the embedded address is rebuilt from the checked names only, so they never reach it.
      if (RULES[name] && !RULES[name].test(p[name])) return null;
    }
    // Either the link names an Apps Script deployment, or this copy names a WordPress site.
    if (!p.s || (!p.d && !site)) return null;
    var room = p.view === 'present' || p.view === 'panel';
    if (room && (p.t || p.k || !p.r)) return null;
    if (!room && (p.layout || p.r || !(p.t || p.k) || (p.t && p.k))) return null;

    var query = room
      ? 'view=' + p.view + '&s=' + p.s + '&r=' + p.r + (p.layout && p.view === 'present' ? '&layout=qr' : '')
      : 's=' + p.s + (p.t ? '&t=' + p.t : '&k=' + p.k) + (p.lang ? '&lang=' + p.lang : '');
    if (!p.d) return site + '?' + query;
    return 'https://script.google.com/macros/s/' + p.d + '/exec?' + query;
  }

  /** The origin a framed screen may send version messages from (see index.html). */
  function origin(url) {
    var found = /^(https:\/\/[^/?#]+)/.exec(String(url || ''));
    return found ? found[1] : '';
  }

  return { target: target, parseQuery: parseQuery, cleanSite: cleanSite, origin: origin };
});
