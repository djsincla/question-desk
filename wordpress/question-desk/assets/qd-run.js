/**
 * google.script.run for the WordPress version. The shared pages call the server only through
 *   google.script.run.withSuccessHandler(fn).withFailureHandler(fn).someFunction(args…)
 * (sometimes keeping the runner and calling runner[name].apply(runner, args)). This provides the
 * same object and sends each call to the plugin's REST route, so the pages need no changes.
 *
 * Handlers run asynchronously, like Apps Script's: success(value), failure(Error). Arguments
 * travel as JSON.
 */
(function () {
  'use strict';
  var config = window.QD_CONFIG || {};

  function send(name, args, onSuccess, onFailure) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', config.endpoint + encodeURIComponent(name));
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (config.nonce) xhr.setRequestHeader('X-WP-Nonce', config.nonce);
    var fail = function (message) {
      if (onFailure) onFailure(new Error(message));
      else if (window.console) window.console.error('Question Desk: ' + name + ': ' + message);
    };
    xhr.onload = function () {
      var body = null;
      try { body = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      if (body && body.ok === true) { if (onSuccess) onSuccess(body.value); return; }
      if (body && body.ok === false) { fail(body.error || 'Something went wrong.'); return; }
      fail(body && body.message ? body.message : 'The server did not answer (' + xhr.status + ').');
    };
    xhr.onerror = function () { fail('Could not reach the server.'); };
    xhr.send(JSON.stringify({ args: args }));
  }

  function runner(onSuccess, onFailure) {
    return new Proxy({}, {
      get: function (target, name) {
        if (name === 'withSuccessHandler') return function (fn) { return runner(fn, onFailure); };
        if (name === 'withFailureHandler') return function (fn) { return runner(onSuccess, fn); };
        if (name === 'withUserObject') return function () { return runner(onSuccess, onFailure); };
        if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
        return function () {
          send(name, Array.prototype.slice.call(arguments), onSuccess, onFailure);
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = runner(null, null);
})();
