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
