// Capture a PROJECT's look as a reusable design preset.
//
// The look an operator arrives at is built over a whole project: the mockup's
// tokens, the component CSS that carries them, whatever was promoted from a
// build along the way, and the reference images they collected while getting it
// right. All of that lived in one container and one asset library, so the next
// project started from the platform defaults regardless of how much was learned.
//
// This reads that look out and hands it to the preset store. It captures what
// the project HAS rather than what a form posted: a preset built from a browser
// payload would be a preset of whatever the browser said.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { DESIGN_CSS_PATH, DESIGN_TOKENS_PATH, parseDesignTokens } from './concept-logic.js';
import { splitMockupCss } from './concept-logic.js';
import { MAX_COMPONENTS_CSS } from './design-presets.js';
import { storePresetReferences, projectReferenceImages } from './design-preset-refs.js';

const APP_DIR = '/srv/app';

function containerSh(containerName, script, { timeoutMs = 30000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readFile(containerName, relPath) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`);
  return r.code === 0 ? (r.stdout || '') : '';
}

function slugify(v, fallback) {
  const s = String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(s) ? s : fallback;
}

// captureProjectDesignPreset(project, { key, name, description })
//   → { ok, preset: { key, name, description, tokens, componentsCss, references } }
export async function captureProjectDesignPreset(project, { key = '', name = '', description = '' } = {}) {
  if (!project?.container_name || project.lifecycle !== 'active') {
    return { ok: false, error: 'The project is not online — start it, then try again.' };
  }
  const presetName = String(name || `${project.name} look`).trim().slice(0, 60);
  const presetKey = slugify(key || presetName, slugify(project.slug || `project-${project.id}`, `project-${project.id}`));
  if (!presetKey) return { ok: false, error: 'Could not derive a preset key — pass one explicitly.' };

  const tokensJson = await readFile(project.container_name, DESIGN_TOKENS_PATH);
  const parsed = parseDesignTokens(tokensJson);
  if (!parsed.ok) {
    return { ok: false, error: 'This project has no approved design tokens yet — approve a design first.' };
  }

  // The component half of design.css: everything that is not the token fence.
  // That INCLUDES anything promoted from a build (the promoted block lives at
  // the end of the same file), which is the point — the elements the operator
  // accepted are part of the look they are saving.
  const designCss = await readFile(project.container_name, DESIGN_CSS_PATH);
  let componentsCss = splitMockupCss(designCss).components.trim();
  // A preset's component block is a design system, not an application.
  if (componentsCss.length > MAX_COMPONENTS_CSS) componentsCss = '';
  // The same two refusals the upload path applies — a captured stylesheet is
  // still a stylesheet that will be served to every app seeded from it.
  if (/@import\b/i.test(componentsCss) || /url\(\s*['"]?\s*(https?:)?\/\//i.test(componentsCss)) componentsCss = '';

  const references = storePresetReferences(presetKey, projectReferenceImages(project.id));

  return {
    ok: true,
    preset: {
      key: presetKey,
      name: presetName,
      description: String(description || `Captured from the ${project.name} project.`).trim().slice(0, 300),
      tokens: parsed.tokens,
      componentsCss,
      references,
    },
  };
}
