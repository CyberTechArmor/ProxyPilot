// Mock2 slug logic (Phase M2) — the pure decision layer for project slugs.
//
// A slug is the DNS label that fronts a project: `<slug>.<parent-domain>`
// (e.g. p-7f3a9c2e.dev.example.com). Per the data model (03-data-model.md)
// and ADR-006, a slug is:
//   - minted as `p-` + 8 lowercase hex chars (opaque; the project name is
//     display-only and never appears in a URL),
//   - unique per parent domain (UNIQUE (parent_domain_id, slug) on both
//     mock2_projects and mock2_slug_history), and
//   - NEVER reusable — once a slug has lived, a mock2_slug_history row blocks
//     it forever, even after the project is gone or rotated away from it.
//
// Stub-first (risk R9): this module imports nothing native. mintSlugCandidate
// takes injected randomness so the mint/uniqueness/retry logic and the
// reserved-prefix guard are unit-testable without better-sqlite3. The DB-aware
// uniqueness loop lives in projects.js and calls back into isReservedSlug /
// isValidSlugShape here.
//
// Terminology (risk R7): nothing here is named "agent".

// Reserved label prefixes a project slug may never take. `_mock2` is Mock2's
// own namespace — the M1 verification canary is `_mock2-verify-<hex>`
// (domain-logic.canaryLabel), so reserving the whole `_mock2` prefix keeps a
// minted slug from ever colliding with a live probe FQDN. The others are
// conventional infrastructure labels that would be confusing as a project URL.
export const RESERVED_SLUG_PREFIXES = ['_mock2'];
export const RESERVED_SLUG_LABELS = new Set(['www', 'api', 'admin', 'mail', 'ftp', 'ns', 'mx']);

// The canonical minted-slug shape. Custom labels are not accepted in M2 —
// every slug is machine-minted — but validating the shape keeps a corrupted
// or hand-edited row from ever being published to Caddy.
export const SLUG_RE = /^p-[0-9a-f]{8}$/;

// isReservedSlug(slug) — true when the label is one the module must never hand
// out (a reserved prefix or a reserved bare label). Checked both by the mint
// loop (which re-mints on a hit — astronomically unlikely for random hex, but
// free insurance) and by any publish path as a belt-and-suspenders guard.
export function isReservedSlug(slug) {
  const s = String(slug || '').toLowerCase();
  if (!s) return true;
  if (RESERVED_SLUG_LABELS.has(s)) return true;
  return RESERVED_SLUG_PREFIXES.some((p) => s.startsWith(p));
}

// isValidSlugShape(slug) — true when the slug matches the minted shape. Used
// to reject anything that could not have come from mintSlugCandidate before it
// reaches a Caddy address (a slug is interpolated into a FQDN, so a malformed
// value is a config-integrity risk, not just a cosmetic one).
export function isValidSlugShape(slug) {
  return SLUG_RE.test(String(slug || ''));
}

// mintSlugCandidate(randHex) — turn an injected hex string into a candidate
// slug. randHex is the caller's randomness (e.g. crypto.randomBytes(...).
// toString('hex')); we take the first 8 hex chars, lowercase. Left/zero-pad if
// the caller supplied too few, so the shape invariant always holds. Returns
// null if the candidate is reserved (the caller re-mints); this never happens
// for real random hex but keeps the guarantee total.
export function mintSlugCandidate(randHex) {
  const hex = String(randHex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const eight = (hex + '00000000').slice(0, 8);
  const slug = `p-${eight}`;
  if (!isValidSlugShape(slug)) return null;
  if (isReservedSlug(slug)) return null;
  return slug;
}

// The full FQDN a slug serves under a parent domain. Pure string join, kept
// here so the route, the Caddy publisher, and the reconcile all derive the
// hostname the same way.
export function slugFqdn(slug, parentDomain) {
  return `${slug}.${parentDomain}`;
}
