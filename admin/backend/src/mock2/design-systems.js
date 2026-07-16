// Mock2 design-system catalog — thin half. Reads the vendored seed bodies for
// the seed-backed catalog entries (framework-seed/design-systems/) and hands the
// pure resolver (design-systems-logic.js) everything it needs to turn a project's
// chosen key into the design-system markdown injected into the concept/mockup
// system prompts.
//
// All decision logic (the catalog, normalization, resolution, the API shape)
// lives in design-systems-logic.js so it is unit-testable without this file's FS
// access. This module is the thin seed reader + the one convenience that couples
// a key to a framework body.
//
// Terminology (risk R7): nothing here is named "agent".

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  BUILTIN_DESIGN_SYSTEMS,
  resolveDesignSystemBody,
  designSystemCatalog,
  normalizeDesignSystemKey,
} from './design-systems-logic.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = resolve(__dir, 'framework-seed', 'design-systems');

// Read every seed-backed entry's markdown once (small files, read lazily +
// cached). A seed that can't be read returns undefined and the resolver falls
// back to the framework body — the render always has a binding design system.
let _seedCache = null;
function seedBodies() {
  if (_seedCache) return _seedCache;
  const out = {};
  for (const e of BUILTIN_DESIGN_SYSTEMS) {
    if (!e.source.startsWith('seed:')) continue;
    const file = e.source.slice('seed:'.length);
    try {
      out[file] = readFileSync(resolve(SEED_DIR, file), 'utf8');
    } catch (err) {
      console.error(`[mock2] design-system seed "${file}" unreadable — falling back to the default look:`, err?.message);
    }
  }
  _seedCache = out;
  return out;
}

// designSystemBody(key, frameworkDesignSystem) — the design-system markdown a
// project's chosen key maps to, ready to inject into a system prompt. `key` is
// the project's stored design_system_key (NULL/unknown → the framework's own).
export function designSystemBody(key, frameworkDesignSystem = '') {
  return resolveDesignSystemBody({
    key,
    frameworkDesignSystem,
    seedBodies: seedBodies(),
  });
}

// designSystemOptions(selectedKey) — the whole catalog shaped for the API, the
// project's current selection flagged. `selectedKey` comes from the project row.
export function designSystemOptions(selectedKey) {
  return designSystemCatalog(selectedKey);
}

export { normalizeDesignSystemKey };
