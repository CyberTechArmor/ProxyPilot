// Cache-Control policy for the built frontend — PURE, so the rule that decides
// whether a deploy can strand someone on the old app is unit-testable.
//
// WHY THIS IS ITS OWN MODULE. "The site is stuck serving the old cache after a
// deploy" is almost never the service worker's fault on its own; it is the HTTP
// layer letting a browser (or a CDN, or a corporate proxy) hold on to the two
// files that POINT AT the current build. Three classes, three rules:
//
//   /assets/*   content-hashed by the build, so the FILENAME is the version.
//               A given URL's bytes can never change, so it is safe to cache
//               for a year — and marking it immutable stops the browser
//               revalidating it at all.
//
//   sw.js       must revalidate every time. A cached service worker is a
//               cached cache: the spec lets a browser reuse it for up to 24
//               hours, during which it keeps serving the old build's rules and
//               never notices there was a deploy.
//
//   index.html  must revalidate every time. It is the pointer that names the
//               hashed assets, so a stale copy pins the whole app to the old
//               build however fresh everything else is. Same for the SPA
//               fallback, which serves the same document under every route.
//
// no-cache does NOT mean "don't store" — it means "ask before reusing". A 304
// is still cheap when nothing changed, so this costs one conditional request
// per load, not a re-download.

// Files that name or govern the current build.
export const REVALIDATE_ALWAYS = Object.freeze(['sw.js', 'index.html', 'manifest.webmanifest']);

export const NO_CACHE = 'no-cache, must-revalidate';
export const IMMUTABLE = 'public, max-age=31536000, immutable';

// cacheControlFor(filePath) → header value, or null to leave the default alone.
// Accepts POSIX or Windows separators; the caller passes whatever the static
// middleware hands it.
export function cacheControlFor(filePath) {
  const p = String(filePath || '');
  const base = p.split(/[\\/]/).pop() || '';
  if (REVALIDATE_ALWAYS.includes(base)) return NO_CACHE;
  // The build emits every hashed file under assets/.
  if (/[\\/]assets[\\/]/.test(p)) return IMMUTABLE;
  return null;
}
