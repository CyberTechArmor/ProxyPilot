// Platform branding — the PURE validation/shape layer for the admin
// dashboard's own name, logo, and favicon (operator-editable; stored in
// app_settings as small data URIs so no file-serving plumbing is needed and
// a DB backup carries the branding with it).
//
// Data URIs only, image types only, hard size caps: the branding endpoint
// must never become an arbitrary-file store, and a favicon that is 5 MB is a
// mistake whatever the operator intended.

export const BRANDING_NAME_MAX = 80;
// Caps are on the STRING length (base64 ≈ 4/3 of binary): ~300 KB logo,
// ~150 KB favicon — generous for raster, huge for SVG.
export const BRANDING_LOGO_MAX_CHARS = 400_000;
export const BRANDING_FAVICON_MAX_CHARS = 200_000;

const DATA_URI_RE = /^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/;

function checkImageField(value, maxChars, label) {
  const v = String(value ?? '').trim();
  if (v === '') return { ok: true, value: '' }; // explicit clear → default branding
  if (v.length > maxChars) return { ok: false, error: `${label} is too large — keep it under ~${Math.round((maxChars * 3) / 4 / 1024)} KB.` };
  if (!DATA_URI_RE.test(v)) return { ok: false, error: `${label} must be an image (PNG, JPEG, WebP, GIF, SVG, or ICO).` };
  return { ok: true, value: v };
}

// validateBrandingPatch(body) → { ok, patch } | { ok:false, error }.
// Only the fields present in the body are validated/updated; an empty string
// clears a field back to the platform default. No recognized fields = error
// (an empty PUT is a client bug, not a no-op).
export function validateBrandingPatch(body = {}) {
  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (name.length > BRANDING_NAME_MAX) return { ok: false, error: `The platform name must be at most ${BRANDING_NAME_MAX} characters.` };
    patch.name = name;
  }
  if (body.logo !== undefined) {
    const r = checkImageField(body.logo, BRANDING_LOGO_MAX_CHARS, 'The logo');
    if (!r.ok) return r;
    patch.logo = r.value;
  }
  if (body.favicon !== undefined) {
    const r = checkImageField(body.favicon, BRANDING_FAVICON_MAX_CHARS, 'The favicon');
    if (!r.ok) return r;
    patch.favicon = r.value;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to update — send name, logo, or favicon.' };
  return { ok: true, patch };
}

// The client-facing shape: unset/cleared fields are null so the frontend can
// fall back to the built-in ProxyPilot branding without string checks.
export function publicBranding({ name, logo, favicon } = {}) {
  return {
    name: String(name || '').trim() || null,
    logo: String(logo || '').trim() || null,
    favicon: String(favicon || '').trim() || null,
  };
}

// decodeDataUri(uri) → { mime, buffer } or null. The stored branding is a
// validated image data URI; this turns it back into bytes so it can be served
// at a real URL (manifest icons and apple-touch-icon cannot be inline data).
export function decodeDataUri(uri) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(uri || '').trim());
  if (!m) return null;
  try {
    return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
  } catch {
    return null;
  }
}

// brandedManifest(base, branding, iconUrl) → the web-app manifest to serve.
// With no custom branding the base (the built file) is returned untouched, so
// a stock install is byte-for-byte the shipped manifest. With a custom name
// the app installs under that name; with a custom favicon (or, failing that,
// logo) the installed icon IS the operator's mark: the shipped rocket icons
// are dropped, because an installer picks the "best" icon by size and would
// otherwise prefer the 512px rocket over the custom one.
export function brandedManifest(base, branding = {}, iconUrl = '/api/branding/icon') {
  const name = String(branding.name || '').trim();
  const mark = decodeDataUri(branding.favicon) || decodeDataUri(branding.logo);
  if (!name && !mark) return base;
  const out = { ...base };
  if (name) {
    out.name = name;
    // short_name is what sits under the icon; 12 characters is the common cap
    // before launchers truncate.
    out.short_name = name.length > 12 ? name.slice(0, 12).trim() : name;
  }
  if (mark) {
    // "any" is the only honest size for an operator-uploaded file; SVG scales
    // and a raster is whatever it is. Chrome accepts it; the sizes attribute
    // is a hint, not a promise.
    out.icons = [
      { src: iconUrl, sizes: 'any', type: mark.mime, purpose: 'any' },
      { src: iconUrl, sizes: 'any', type: mark.mime, purpose: 'maskable' },
    ];
  }
  return out;
}

// withInstalledAppHint(manifest, manifestUrl) → the manifest plus a
// related_applications entry naming ITSELF. That is the hook
// navigator.getInstalledRelatedApps() needs: with it, the page can tell "this
// browser already has ProxyPilot installed" — which is the one case where
// Chromium silently withholds the install prompt — and say so instead of
// showing steps that lead nowhere. The URL must be absolute and match the
// manifest URL the installed app was created from. prefer_related_applications
// stays false: the entry is for detection, never a redirect to a store.
export function withInstalledAppHint(manifest, manifestUrl) {
  if (!manifestUrl) return manifest;
  return {
    ...manifest,
    prefer_related_applications: false,
    related_applications: [{ platform: 'webapp', url: manifestUrl }],
  };
}
