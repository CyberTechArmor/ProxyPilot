// Mock2 PROJECT ICONS — the native half (asset bytes → container files).
//
// See project-icons-logic.js for WHY. In short: the operator's logo reached the
// mockup and never reached the app's favicon, home-screen icon or manifest, so
// everywhere the app was seen outside its own pages it was anonymous.
//
// Best-effort throughout: no logo, an unusable logo, or a busy container are
// ordinary outcomes. The scaffold's own mark stays and the build carries on.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { listAssets, readAssetImage } from './project-assets.js';
import {
  selectIconAsset, buildManifest, applyIconLinks,
} from './project-icons-logic.js';

const APP_DIR = '/srv/app';
// The pages that carry a <head> the scaffold owns. login.html is deliberately
// included: it is the FIRST page anyone sees, and often the only one they see
// before deciding whether the app looks real.
const ICON_PAGES = Object.freeze([
  'public/app-shell.html', 'public/login.html', 'public/admin.html', 'public/profile.html',
]);

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readContainerFile(containerName, relPath, { timeoutMs = 30000 } = {}) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`, { timeoutMs });
  return r.code === 0 ? (r.stdout || '') : '';
}

// Write a text file into the container. base64 the whole way so content with
// quotes, newlines or a stray backslash cannot be mangled by the shell — the
// escape-eating class of bug this codebase has hit three times.
async function writeContainerText(containerName, relPath, content, { timeoutMs = 60000 } = {}) {
  const script = [
    'set -e',
    `mkdir -p "$(dirname '${APP_DIR}/${relPath}')"`,
    `printf '%s' '${b64(content)}' | base64 -d > '${APP_DIR}/${relPath}'`,
  ].join('\n');
  const r = await containerSh(containerName, script, { timeoutMs });
  return r.code === 0;
}

// Same, for bytes we already hold as base64 (the asset image).
async function writeContainerBinary(containerName, relPath, base64Data, { timeoutMs = 60000 } = {}) {
  const script = [
    'set -e',
    `mkdir -p "$(dirname '${APP_DIR}/${relPath}')"`,
    `printf '%s' '${base64Data}' | base64 -d > '${APP_DIR}/${relPath}'`,
  ].join('\n');
  const r = await containerSh(containerName, script, { timeoutMs });
  return r.code === 0;
}

// applyProjectIcons — put the project's logo where a browser looks for it.
//
// Returns { ok, state, reason, icon } and never throws:
//   'applied'  — the icon, the manifest and the page links are in place
//   'default'  — no usable logo; the scaffold's mark stays (NOT an error)
//   'offline'  — nothing to write to
//   'failed'   — the container refused a write
export async function applyProjectIcons(project, { timeoutMs = 60000 } = {}) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ok: false, state: 'offline', reason: 'the project is not online', icon: null };
  }

  let assets = [];
  try { assets = listAssets(project.id); } catch { assets = []; }
  const picked = selectIconAsset(assets);

  // No usable logo is the ordinary case, and the manifest is still rewritten:
  // the project may have been RENAMED, and the app name in the manifest is what
  // the home-screen label says.
  const icon = picked.ok ? { href: picked.href, mime: picked.mime } : null;

  try {
    if (picked.ok) {
      const img = readAssetImage(project.id, picked.asset.id);
      if (!img) return { ok: false, state: 'failed', reason: 'the logo asset has no bytes on disk', icon: null };
      if (!await writeContainerBinary(containerName, picked.path, img.data, { timeoutMs })) {
        return { ok: false, state: 'failed', reason: `could not write ${picked.path}`, icon: null };
      }
    }

    const manifest = buildManifest({ name: project.name, icon });
    if (!await writeContainerText(containerName, 'public/manifest.webmanifest', manifest, { timeoutMs })) {
      return { ok: false, state: 'failed', reason: 'could not write the manifest', icon };
    }

    // The page <head> links. Only pages that EXIST and actually have a head are
    // touched; a build that replaced a page keeps whatever it wrote, minus the
    // fenced icon block which is ours to maintain.
    const touched = [];
    for (const page of ICON_PAGES) {
      const html = await readContainerFile(containerName, page, { timeoutMs });
      if (!html) continue;
      const next = applyIconLinks(html, icon);
      if (next === html) continue;
      if (await writeContainerText(containerName, page, next, { timeoutMs })) touched.push(page);
    }

    return {
      ok: true,
      state: picked.ok ? 'applied' : 'default',
      reason: picked.ok
        ? `using "${picked.asset.name}" as the app icon (${touched.length} page(s) updated)`
        : `keeping the default mark — ${picked.reason}`,
      icon,
      pages: touched,
    };
  } catch (e) {
    return { ok: false, state: 'failed', reason: e?.message || 'exec failed', icon: null };
  }
}
