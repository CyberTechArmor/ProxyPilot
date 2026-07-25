'use strict';
/* Theme (light / dark / follow the system).
 *
 * Loaded FIRST and synchronously in <head> so the stored choice is applied
 * before the first paint — a deferred script would show a light flash on every
 * load for a dark-mode user.
 *
 * Three states, deliberately: 'light' and 'dark' are explicit choices that
 * stick; 'system' (the default) follows the OS and keeps following it when the
 * OS flips. Cycling the control goes system -> light -> dark -> system, so a
 * user can always get back to "just match my device".
 */
(function () {
  var KEY = 'ud-theme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function stored() {
    try { var v = localStorage.getItem(KEY); return (v === 'light' || v === 'dark' || v === 'system') ? v : 'system'; }
    catch (_) { return 'system'; }   // private mode / storage disabled
  }
  function effective(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return media && media.matches ? 'dark' : 'light';
  }
  function apply(pref) {
    var t = effective(pref);
    document.documentElement.setAttribute('data-theme', t);
    // Let the browser paint form controls/scrollbars to match.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0d1725' : '#f5f8fc');
    return t;
  }

  var pref = stored();
  apply(pref);

  // Follow the OS while the preference is 'system'.
  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (stored() === 'system') { apply('system'); Theme.notify(); } });
  }

  var listeners = [];
  var Theme = {
    KEY: KEY,
    get: stored,
    resolved: function () { return effective(stored()); },
    set: function (pref) {
      try { localStorage.setItem(KEY, pref); } catch (_) {}
      apply(pref);
      Theme.notify();
    },
    // system -> light -> dark -> system
    cycle: function () {
      var order = ['system', 'light', 'dark'];
      var i = order.indexOf(stored());
      Theme.set(order[(i + 1) % order.length]);
      return stored();
    },
    onChange: function (fn) { listeners.push(fn); },
    notify: function () { listeners.forEach(function (f) { try { f(stored(), effective(stored())); } catch (_) {} }); },

    /* Markup for the header control. Shows the icon for what you'd GET next and
     * names the current state for screen readers. */
    buttonHtml: function (id) {
      var pref = stored();
      var label = pref === 'system' ? 'Theme: match device' : pref === 'light' ? 'Theme: light' : 'Theme: dark';
      return '<button class="theme-toggle" id="' + (id || 'themeToggle') + '" type="button"' +
        ' title="' + label + ' — click to change" aria-label="' + label + '. Click to change theme.">' +
        Theme.iconFor(pref) + '</button>';
    },
    iconFor: function (pref) {
      if (pref === 'light') {  // sun
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
      }
      if (pref === 'dark') {   // moon
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
      }
      // system: half-filled display
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 20h8M12 18v2"/><path d="M12 8v6a3 3 0 0 0 0-6z" fill="currentColor" stroke="none"/></svg>';
    },
    /* Toggles are wired by DELEGATION, installed once below — every screen
     * re-renders its header (shell, auth, lock screen), and binding per-render
     * silently misses whichever path nobody remembered to update. Delegation
     * covers every .theme-toggle that will ever exist, including ones inside a
     * modal. bind() is kept as a no-op so existing call sites stay valid. */
    bind: function () {}
  };
  // One delegated click handler for every .theme-toggle, now and later.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.theme-toggle') : null;
    if (!btn) return;
    e.preventDefault();
    Theme.cycle();
    refreshButtons();
  });

  function refreshButtons() {
    var pref = stored();
    var label = pref === 'system' ? 'Theme: match device' : pref === 'light' ? 'Theme: light' : 'Theme: dark';
    document.querySelectorAll('.theme-toggle').forEach(function (b) {
      b.innerHTML = Theme.iconFor(pref);
      b.setAttribute('title', label + ' \u2014 click to change');
      b.setAttribute('aria-label', label + '. Click to change theme.');
    });
  }
  // Keep every rendered button in sync when the OS flips under 'system'.
  Theme.onChange(refreshButtons);

  window.Theme = Theme;
})();
