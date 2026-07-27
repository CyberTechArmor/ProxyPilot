// Mock2 PROJECT ICONS — the pure half.
//
// WHY THIS EXISTS: the operator uploads their logo to the project asset
// library, the mockup is now shown it, and the built app still shipped the
// scaffold's generic blue circle as its favicon, its home-screen icon and its
// PWA manifest icon. Everywhere the app is seen OUTSIDE its own pages — the
// browser tab, the phone home screen, the install prompt, the task switcher —
// it was still anonymous.
//
// Nothing here needs a model and nothing needs an image library: the logo is
// already an image file, so the work is choosing the right one, giving it a
// stable path, and writing the two files that point at it.
//
// Split from project-icons.js so the selection and the generated documents are
// unit-testable without a container or the asset store.

// The tags that mean "this is the app's mark", best first. A favicon is
// PURPOSE-BUILT for this and beats a full logo when both exist; a wordmark
// scaled into a 192px square is usually illegible.
export const ICON_TAG_PREFERENCE = Object.freeze(['favicon', 'logo']);

// Formats a browser will accept as an icon. SVG first — it is resolution
// independent, so one file covers every size the manifest declares.
export const ICON_MIME_BY_EXT = Object.freeze({
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
});

// An icon has to be square-ish to survive being masked into a circle or a
// squircle. A 4:1 wordmark becomes a smear, which looks worse than the
// scaffold's honest placeholder — so it is declined rather than used badly.
export const MAX_ICON_ASPECT = 1.6;
// Beyond this the manifest is carrying megabytes to draw a 192px square, and
// every install prompt pays for it.
export const MAX_ICON_BYTES = 1024 * 1024;

export function iconExt(name) {
  const s = String(name || '').toLowerCase();
  const i = s.lastIndexOf('.');
  return i === -1 ? '' : s.slice(i);
}

// selectIconAsset — which asset (if any) should become the app's icon.
//
// Returns { asset, ext, mime } or null with a `reason` a human can act on:
// "your logo is 4:1, upload a square mark" is useful, silently keeping the
// placeholder is not.
export function selectIconAsset(assets = []) {
  const images = (assets || []).filter((a) => a && a.kind === 'image');
  const tagged = images.filter((a) => ICON_TAG_PREFERENCE.includes(a.tag));
  if (!tagged.length) {
    return { ok: false, reason: images.length ? 'no asset is tagged Logo or Favicon' : 'no images in the asset library' };
  }
  const rank = (a) => ICON_TAG_PREFERENCE.indexOf(a.tag);
  const ordered = [...tagged].sort((a, b) => rank(a) - rank(b) || (a.id || 0) - (b.id || 0));

  const rejected = [];
  for (const asset of ordered) {
    const ext = iconExt(asset.name);
    const mime = ICON_MIME_BY_EXT[ext];
    if (!mime) { rejected.push(`${asset.name}: ${ext || 'no extension'} is not an icon format`); continue; }
    if (asset.size && asset.size > MAX_ICON_BYTES) {
      rejected.push(`${asset.name}: ${Math.round(asset.size / 1024)}KB is too large for an icon`);
      continue;
    }
    // Dimensions are optional (an SVG has none); only judge what we know.
    if (asset.width && asset.height) {
      const aspect = Math.max(asset.width, asset.height) / Math.min(asset.width, asset.height);
      if (aspect > MAX_ICON_ASPECT) {
        rejected.push(`${asset.name}: ${asset.width}x${asset.height} is too wide to mask into an icon — upload a square mark`);
        continue;
      }
    }
    return { ok: true, asset, ext, mime, path: `public/app-icon${ext}`, href: `/app-icon${ext}` };
  }
  return { ok: false, reason: rejected.join('; ') || 'no usable icon' };
}

// The manifest, with the project's own icon when there is one.
//
// Kept here rather than in scaffold.js so both the first scaffold and a later
// re-brand produce the SAME document — two generators drifting apart is how an
// app ends up with a logo in the tab and a placeholder on the home screen.
export function buildManifest({ name = 'Application', icon = null, themeColor = '#0d1524', backgroundColor = '#0d1524' } = {}) {
  const appName = String(name || 'Application').slice(0, 60);
  const icons = [];
  if (icon?.href) {
    // `any maskable` on a raster is a claim we cannot verify — a logo with no
    // padding gets its edges cropped by the mask. Only SVG (which we could
    // pad) claims maskable; a raster declares `any` and is letterboxed instead
    // of mutilated.
    icons.push({
      src: icon.href,
      sizes: icon.mime === 'image/svg+xml' ? 'any' : '512x512',
      type: icon.mime,
      purpose: icon.mime === 'image/svg+xml' ? 'any maskable' : 'any',
    });
  }
  // The scaffold's own mark always stays as the fallback: a manifest whose only
  // icon 404s shows nothing at all, which is worse than a generic square.
  icons.push({ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' });

  return `${JSON.stringify({
    name: appName,
    short_name: appName.length > 12 ? appName.slice(0, 12).trim() : appName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: backgroundColor,
    theme_color: themeColor,
    icons,
  }, null, 2)}\n`;
}

// The <head> links every page carries. Two of them, and both matter:
//   rel="icon"             — the browser tab and the bookmark
//   rel="apple-touch-icon" — iOS home screen, which ignores the manifest
export function iconHeadLinks(icon = null) {
  const lines = [];
  if (icon?.href) {
    lines.push(`<link rel="icon" href="${icon.href}" type="${icon.mime}">`);
    lines.push(`<link rel="apple-touch-icon" href="${icon.href}">`);
  } else {
    lines.push('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
  }
  return lines.join('\n');
}

// Rewrite a page's head to point at the project's icon.
//
// Idempotent: the generated links are fenced by a marker comment, so a rebrand
// replaces them rather than appending a second set. Pages the operator or the
// build has restyled keep everything else exactly as it is.
export const ICON_BLOCK_START = '<!-- pp:icons -->';
export const ICON_BLOCK_END = '<!-- /pp:icons -->';

export function applyIconLinks(html, icon = null) {
  const block = `${ICON_BLOCK_START}\n${iconHeadLinks(icon)}\n${ICON_BLOCK_END}`;
  const s = String(html || '');
  if (!s) return s;
  const start = s.indexOf(ICON_BLOCK_START);
  if (start !== -1) {
    const end = s.indexOf(ICON_BLOCK_END, start);
    if (end !== -1) return s.slice(0, start) + block + s.slice(end + ICON_BLOCK_END.length);
  }
  // First time: insert before </head>. A page with no head is left alone rather
  // than guessed at.
  const head = s.search(/<\/head\s*>/i);
  if (head === -1) return s;
  return `${s.slice(0, head)}${block}\n${s.slice(head)}`;
}
