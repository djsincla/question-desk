/**
 * Turns whatever Question Desk link someone pastes into the address a slide
 * should show. Shared by the add-in page and the Node tests.
 *
 * Accepts room screen, queue or participant links in any form Google uses:
 *   https://script.google.com/macros/s/<id>/exec?...
 *   https://script.google.com/a/macros/<domain>/s/<id>/exec?...
 *   https://script.google.com/a/<domain>/macros/s/<id>/exec?...
 * and always returns the public /macros/s/ form, because PowerPoint's built-in
 * browser can't sign in to Google. Anything else is rejected, so the add-in
 * only ever frames a Question Desk room screen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomUrl = factory();
})(this, function () {
  var PATTERN = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/?#]+\/s\/|a\/[^\/?#]+\/macros\/s\/|macros\/s\/)([A-Za-z0-9_-]+)\/exec(?:\?([^#]*))?(?:#.*)?$/;

  function parse(input) {
    var match = String(input || '').trim().match(PATTERN);
    if (!match) return null;
    var params = {};
    (match[2] || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      try {
        params[decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))] = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
      } catch (err) { /* ignore malformed pairs */ }
    });
    if (!/^[a-f0-9]{8}$/.test(params.s || '')) return null;
    return { deployment: match[1], session: params.s };
  }

  /** Room screen address for a slide: QR only unless full is true. */
  function forSlide(input, full) {
    var parsed = parse(input);
    if (!parsed) return null;
    return 'https://script.google.com/macros/s/' + parsed.deployment + '/exec?view=present&s=' +
      parsed.session + (full ? '' : '&layout=qr');
  }

  return { parse: parse, forSlide: forSlide };
});
