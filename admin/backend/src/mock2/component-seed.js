// Mock2 built-in component seeding — the auth component ships WITH the
// backend (framework-seed/proxypilot-auth.component.json, the same document
// Projects → Components → Import accepts) and is seeded at boot, so a fresh
// install gets the sign-in + first-admin base app without any manual import.
//
// Exists because the deterministic auth wiring (scaffold-auth.js) keys off the
// component's contract: an operator running an OLD imported document (no
// src/auth/index.ts barrel, no migrations) silently never wires — projects
// then serve the bare scaffold page instead of the login/bootstrap flow, with
// nothing telling anyone why. Seeding makes the platform self-sufficient.
//
// Upgrade rule (deliberately conservative — component upgrade is otherwise a
// future flow): an existing component with the same key is REPLACED with a new
// version only when the stored current version cannot wire the bootstrap
// (componentWiresBootstrap false) while the bundled document can — i.e. we
// heal the known-broken state and never stomp operator content that works.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  getComponentByKey, getCurrentComponentVersion, insertComponent, insertComponentVersion,
} from './components.js';
import { parseComponentImport, parseContractJson } from './component-logic.js';
import { componentWiresBootstrap } from './scaffold-auth.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const SEED_DOC = resolve(__dir, 'framework-seed', 'proxypilot-auth.component.json');

// A stored version wires when its contract + file list satisfy the detector.
function versionWires(versionRow) {
  if (!versionRow) return false;
  let files = [];
  try { files = JSON.parse(versionRow.files_json) || []; } catch { files = []; }
  return componentWiresBootstrap(parseContractJson(versionRow.contract_json), files);
}

// seedBuiltinComponents() → { seeded: [...], skipped: [...] }. Idempotent and
// best-effort per document; called once at enabled boot next to the framework
// seed. Never throws (a bad seed file must not stop the backend).
export function seedBuiltinComponents(createdBy = null) {
  // created_by is NOT NULL (integer, no FK) — 0 is the system sentinel for
  // "seeded by the platform, not a person".
  const actor = Number.isInteger(createdBy) ? createdBy : 0;
  const seeded = [];
  const skipped = [];
  let doc;
  try {
    doc = JSON.parse(readFileSync(SEED_DOC, 'utf8'));
  } catch (e) {
    console.warn('[mock2] component seed unreadable:', e?.message);
    return { seeded, skipped };
  }
  const check = parseComponentImport(doc);
  if (!check.ok) {
    console.warn('[mock2] component seed invalid:', check.error);
    return { seeded, skipped };
  }
  const d = check.data;
  try {
    const existing = getComponentByKey(d.key);
    if (!existing) {
      insertComponent({
        key: d.key, name: d.name, description: d.description, category: d.category,
        tags: d.tags, files: d.files, usage_md: d.usage_md, contract: d.contract,
        change_reason: 'Bundled with ProxyPilot — seeded at startup',
        source: 'import', createdBy: actor,
      });
      seeded.push({ key: d.key, as: 'new_component' });
      console.log(`[mock2] seeded built-in component ${d.key}`);
      return { seeded, skipped };
    }
    const current = getCurrentComponentVersion(existing);
    const seedWires = componentWiresBootstrap(d.contract, d.files);
    if (versionWires(current) || !seedWires) {
      // The stored current version already wires (operator content is fine or
      // newer), or the bundle would not improve it — leave it alone.
      skipped.push({ key: d.key, reason: 'current version wires (or seed would not)' });
      return { seeded, skipped };
    }
    const version = insertComponentVersion(existing.id, {
      files: d.files, usage_md: d.usage_md, contract: d.contract,
      change_reason: 'Bundled update seeded at startup — the stored version could not wire the auth bootstrap (old imported document)',
      source: 'import', createdBy: actor,
    });
    seeded.push({ key: d.key, as: 'new_version', version: version.version });
    console.log(`[mock2] upgraded built-in component ${d.key} to v${version.version} (stored version could not wire the auth bootstrap)`);
  } catch (e) {
    console.warn(`[mock2] component seed failed for ${d.key}:`, e?.message);
  }
  return { seeded, skipped };
}
