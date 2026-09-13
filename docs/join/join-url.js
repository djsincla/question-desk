/**
 * Builds the Question Desk address a join/room wrapper page embeds, from the wrapper's
 * own query string. Only guest pages (participant page, room screen) on a
 * script.google.com Apps Script deployment are allowed. Shared with the Node tests.
 *
 *   ?d=<deployment id>&s=<session>&t=<room code>      participant page, in-room session
 *   ?d=<deployment id>&s=<session>&k=<link key>       participant page, shareable link
 *   ?d=<deployment id>&view=present&s=<session>       room screen (optionally &layout=qr)
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
    view: /^present$/,
    layout: /^qr$/,
    lang: /^(en|ko|es)$/
  };

  function parseQuery(search) {
    var out = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      try {
        out[decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))] = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      } catch (err) { /* ignore malformed pairs */ }
    });
    return out;
  }

  /** Returns the address to embed, or null if the wrapper's address isn't a valid guest link. */
  function target(search) {
    var p = parseQuery(search);
    for (var name in p) {
      if (!RULES[name] || !RULES[name].test(p[name])) return null;
    }
    if (!p.d || !p.s) return null;
    var room = p.view === 'present';
    if (room && (p.t || p.k)) return null;
    if (!room && (p.layout || !(p.t || p.k) || (p.t && p.k))) return null;

    var query = room
      ? 'view=present&s=' + p.s + (p.layout ? '&layout=qr' : '')
      : 's=' + p.s + (p.t ? '&t=' + p.t : '&k=' + p.k) + (p.lang ? '&lang=' + p.lang : '');
    return 'https://script.google.com/macros/s/' + p.d + '/exec?' + query;
  }

  return { target: target, parseQuery: parseQuery };
});
