// Mock2 DESIGN PROMOTION — the native half (container read/write).
//
// See design-promote-logic.js for WHY: the approved vocabulary was frozen at
// the mockup, so a build that invented a better element had no way for that
// element to ever become part of the design. This reads what a build invented
// out of the project's own stylesheets and writes an accepted one into
// state/design.css, after which it IS the approved design.
//
// Everything here is best-effort about READING (an offline project reports no
// candidates rather than throwing) and strict about WRITING (a promotion that
// could not be written must say so — an operator who is told an element was
// accepted and finds it gone next build has been lied to).
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { DESIGN_CSS_PATH } from './concept-logic.js';
import { promotionCandidates, promoteInto, splitPromoted, splitPromotedEntries } from './design-promote-logic.js';

const APP_DIR = '/srv/app';

function containerSh(containerName, script, { timeoutMs = 30000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`);
  return r.code === 0 ? (r.stdout || '') : '';
}

// The app's OWN stylesheets — the same set the adherence gate measures, and for
// the same reason: base.css and platform.css are the shell's, design.css is the
// approved design's, and neither is something a build invented.
async function readAppCss(containerName) {
  const script = `for f in ${APP_DIR}/public/*.css; do
  [ -f "$f" ] || continue
  case "$f" in */base.css|*/design.css|*/platform.css) continue ;; esac
  cat "$f"
done
# Inline <style> blocks are app CSS by another name — the same rule the
# adherence gate applies, so the two agree on what "the build wrote" means.
for f in ${APP_DIR}/public/*.html; do
  [ -f "$f" ] || continue
  case "$f" in */login.html|*/admin.html|*/profile.html) continue ;; esac
  awk 'BEGIN{p=0} index($0,"<style"){p=1} p{print} index($0,"</style>"){p=0}' "$f"
done
exit 0`;
  const r = await containerSh(containerName, script, { timeoutMs: 30000 });
  return r.code === 0 ? (r.stdout || '') : '';
}

// listNewElements(project) → { ok, candidates, promoted, offline }.
//
// `promoted` is what has ALREADY been accepted, so the panel can show the
// design growing rather than only ever offering more.
export async function listNewElements(project) {
  if (!project?.container_name || project.lifecycle !== 'active') {
    return { ok: true, offline: true, candidates: [], promoted: [] };
  }
  try {
    const designCss = await readFile(project.container_name, DESIGN_CSS_PATH);
    if (!designCss.trim()) {
      return { ok: true, offline: false, candidates: [], promoted: [], reason: 'This project has no approved design yet.' };
    }
    const appCss = await readAppCss(project.container_name);
    return {
      ok: true,
      offline: false,
      candidates: promotionCandidates({ designCss, appCss }),
      promoted: splitPromotedEntries(splitPromoted(designCss).promoted).map((e) => e.name),
    };
  } catch (e) {
    console.warn(`[mock2] new-element listing failed for project ${project.id}:`, e?.message);
    return { ok: true, offline: true, candidates: [], promoted: [] };
  }
}

// promoteElements(project, names) — accept these into the approved design.
//
// The CSS is re-read from the container rather than taken from the caller: a
// promotion must move what the app ACTUALLY has, not what a browser posted.
export async function promoteElements(project, names = []) {
  if (!project?.container_name || project.lifecycle !== 'active') {
    return { ok: false, error: 'The project is not online — start it, then try again.' };
  }
  const wanted = new Set((Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean));
  if (!wanted.size) return { ok: false, error: 'No elements were selected.' };
  try {
    const designCss = await readFile(project.container_name, DESIGN_CSS_PATH);
    if (!designCss.trim()) return { ok: false, error: 'This project has no approved design to add to.' };
    const appCss = await readAppCss(project.container_name);
    const chosen = promotionCandidates({ designCss, appCss }).filter((c) => wanted.has(c.name));
    if (!chosen.length) {
      return { ok: false, error: 'Those elements are no longer in the app’s stylesheets — reload the list.' };
    }
    const { css, promoted, skipped } = promoteInto(designCss, chosen);
    // ENCODED payload on stdin — decoding on the host too would write four
    // bytes of garbage over the approved design. See base-app-upgrade.js.
    const script = `d="${APP_DIR}/${DESIGN_CSS_PATH}"; mkdir -p "$(dirname "$d")"; base64 -d > "$d"`;
    const r = await sh(
      `incus exec ${project.container_name} -- sh -c "$(printf '%s' '${b64(script)}' | base64 -d)"`,
      { timeoutMs: 30000, input: b64(css) },
    );
    if (r.code !== 0) {
      return { ok: false, error: `The approved design could not be written: ${(r.stderr || r.stdout || '').trim().slice(-200)}` };
    }
    return { ok: true, promoted, skipped };
  } catch (e) {
    console.warn(`[mock2] element promotion failed for project ${project.id}:`, e?.message);
    return { ok: false, error: 'The promotion could not be applied. Check that the project is online.' };
  }
}

export { promotionInviteMessage } from './design-promote-logic.js';
