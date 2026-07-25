'use strict';
/* ---------------------------------------------------------------------------
   Branding + legal pages (client).

   Two jobs:
   1. Fetch and cache the public branding projection, and expose the pieces the
      sign-in screen needs: the logo, the copyright notice, and the footer links.
   2. Render the legal pages themselves.

   Both must work with NO session — they are reachable from the sign-in screen.
   --------------------------------------------------------------------------- */
(function () {
  var cache = null;          // last public projection
  var pending = null;        // in-flight fetch, so N callers make one request
  var pageCache = {};        // slug -> page

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function load(force) {
    if (cache && !force) return Promise.resolve(cache);
    if (pending && !force) return pending;
    pending = fetch('/api/branding', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { cache = (d && d.branding) || fallback(); pending = null; applyDocument(); return cache; })
      .catch(function () { cache = cache || fallback(); pending = null; return cache; });
    return pending;
  }

  // If the endpoint is unreachable the sign-in screen still needs a legally
  // complete footer, so synthesise one rather than rendering an empty bar.
  function fallback() {
    var y = new Date().getFullYear();
    return {
      orgName: 'Upload Doc', legalName: '', rightsMark: '', rightsText: 'All rights reserved.',
      year: y, copyright: '© ' + y + ' Upload Doc. All rights reserved.',
      logoUrl: null, faviconUrl: null,
      appContext: { summary: '', audience: '', features: [] },
      legal: [{ slug: 'privacy', title: 'Privacy Policy' }, { slug: 'terms', title: 'Terms & Conditions' }]
    };
  }

  function get() { return cache || fallback(); }

  /* The year is recomputed on every read rather than trusting the cached
     projection: a kiosk or a left-open tab can outlive New Year, and a footer
     that silently claims the wrong year is exactly the kind of thing nobody
     notices until a customer does. */
  function copyright() {
    var b = get();
    var y = new Date().getFullYear();
    if (b.copyright && b.year === y) return b.copyright;
    var name = b.legalName || b.orgName || 'Upload Doc';
    var mark = b.rightsMark === '®' || b.rightsMark === '™' ? b.rightsMark : '';
    var rights = (b.rightsText || '').trim();
    return '© ' + y + ' ' + name + mark + '.' + (rights ? ' ' + rights : '');
  }

  // Reflect branding onto the document itself: title suffix + favicon link.
  function applyDocument() {
    var b = get();
    if (b.faviconUrl) {
      var link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.setAttribute('rel', 'icon'); document.head.appendChild(link); }
      // Same URL every time unless the asset changed, so no refetch churn.
      if (link.getAttribute('href') !== b.faviconUrl) link.setAttribute('href', b.faviconUrl);
    }
  }

  /* --------------------------- the sign-in footer -------------------------- */
  // Plain text plus two buttons, per the brief: the notice reads as text, the
  // page links are real buttons so they are keyboard- and touch-reachable.
  function footerHtml() {
    var b = get();
    var links = (b.legal || []).map(function (l) {
      return '<button type="button" class="legal-link" data-legal="' + esc(l.slug) + '">' + esc(l.title) + '</button>';
    }).join('<span class="legal-sep" aria-hidden="true">·</span>');
    return '<div class="legal-footer">' +
      '<div class="legal-links">' + links + '</div>' +
      '<div class="legal-copy">' + esc(copyright()) + '</div>' +
      '</div>';
  }

  /* ----------------------------- legal pages ------------------------------ */
  function fetchPage(slug) {
    if (pageCache[slug]) return Promise.resolve(pageCache[slug]);
    return fetch('/api/legal/' + encodeURIComponent(slug), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.page) { pageCache[slug] = d.page; return d.page; } return null; })
      .catch(function () { return null; });
  }

  /* Body markup is a deliberately tiny subset — "## " headings, "- " bullets,
     blank-line paragraphs — rendered by escaping FIRST and then wrapping. No
     raw HTML from the store ever reaches innerHTML, so an admin with page-edit
     rights cannot turn the (unauthenticated) privacy page into a script host. */
  function renderBody(text) {
    var lines = String(text || '').split('\n');
    var out = [];
    var para = [];
    var bullets = [];
    function flushPara() { if (para.length) { out.push('<p>' + esc(para.join(' ')) + '</p>'); para = []; } }
    function flushList() { if (bullets.length) { out.push('<ul>' + bullets.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>'); bullets = []; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln) { flushPara(); flushList(); continue; }
      if (ln.slice(0, 3) === '## ') { flushPara(); flushList(); out.push('<h2>' + esc(ln.slice(3).trim()) + '</h2>'); continue; }
      if (ln.slice(0, 2) === '- ') { flushPara(); bullets.push(ln.slice(2).trim()); continue; }
      flushList();
      para.push(ln);
    }
    flushPara(); flushList();
    return out.join('');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  /* Full-page legal view. `onBack` returns wherever the reader came from, so
     the same page serves a signed-out visitor and a signed-in user. */
  function renderPage(container, slug, onBack) {
    container.innerHTML = '<div class="legal-page"><div class="legal-inner"><div class="muted">Loading…</div></div></div>';
    return Promise.all([load(), fetchPage(slug)]).then(function (r) {
      var b = r[0], pg = r[1];
      if (!pg) {
        container.innerHTML = '<div class="legal-page"><div class="legal-inner">' +
          '<button type="button" class="btn ghost legal-back" id="legalBack">← Back</button>' +
          '<div class="alert err">That page could not be loaded.</div></div></div>';
      } else {
        var revised = pg.updatedAt ? 'Last updated ' + fmtDate(pg.updatedAt) : 'Standard terms — not yet customised';
        container.innerHTML = '<div class="legal-page"><div class="legal-inner">' +
          '<button type="button" class="btn ghost legal-back" id="legalBack">← Back</button>' +
          '<h1>' + esc(pg.title) + '</h1>' +
          '<p class="legal-meta">' + esc(b.legalName || b.orgName) + ' · ' + esc(revised) + '</p>' +
          '<div class="legal-body">' + renderBody(pg.body) + '</div>' +
          '<div class="legal-foot">' + esc(copyright()) + '</div>' +
          '</div></div>';
      }
      var back = container.querySelector('#legalBack');
      if (back) back.onclick = function () { if (onBack) onBack(); };
    });
  }

  window.Branding = {
    load: load, get: get, copyright: copyright, footerHtml: footerHtml,
    renderPage: renderPage, renderBody: renderBody, fetchPage: fetchPage,
    applyDocument: applyDocument,
    invalidate: function () { cache = null; pageCache = {}; }
  };

  // Warm the cache as early as possible so the first sign-in paint has a real
  // org name instead of the fallback.
  load();
})();
