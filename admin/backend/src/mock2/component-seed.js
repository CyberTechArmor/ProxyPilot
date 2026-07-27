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
// Upgrade rule. It used to be: replace only when the stored current version
// cannot WIRE the bootstrap. That is a liveness test, not a currency test, and
// it had a long tail — once any version that wires is stored, the bundled
// document is never applied again, however much its CONTENT has moved on.
//
// That shipped a real defect. The auth component gained an @fixture.invalid
// exclusion in usersExist() — the thing that keeps the platform's own review
// fixture from consuming the operator's first-admin bootstrap — and every
// install whose stored version already wired kept the old code. On those, the
// platform seeded design-review@fixture.invalid before its smoke checks, the
// app counted it as a real user, and the operator's create-the-first-
// administrator form closed mid-build. Which is exactly what it looked like
// from outside: "there is limited time from seeing the create super admin
// first user, then when the app finishes I'm unable to log in."
//
// So: replace when the bundled document DIFFERS from the stored current
// version, and the stored one is the platform's own (created_by 0). Operator
// content is still never stomped — but a difference there is now reported
// loudly instead of passing as "current version wires".

import { createHash } from 'crypto';
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

// The identity of a component's CONTENT — every file body, the contract and the
// usage notes. Sorted by path so a re-ordered document is not a change.
export function componentContentHash({ files = [], contract = null, usage_md = null } = {}) {
  const norm = (Array.isArray(files) ? files : [])
    .map((f) => ({ path: String(f?.path || ''), content: String(f?.content ?? '') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify({ files: norm, contract: contract || null, usage_md: usage_md ?? null }))
    .digest('hex');
}

function storedContentHash(versionRow) {
  if (!versionRow) return null;
  let files = [];
  try { files = JSON.parse(versionRow.files_json) || []; } catch { files = []; }
  return componentContentHash({
    files,
    contract: parseContractJson(versionRow.contract_json),
    usage_md: versionRow.usage_md ?? null,
  });
}

// created_by 0 is the platform's own sentinel (see below). A version an
// operator imported or authored is theirs, and this seed does not touch it.
function isPlatformOwned(versionRow) {
  return Number(versionRow?.created_by) === 0;
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
    if (!seedWires) {
      // The bundle itself could not wire — never replace working content with it.
      skipped.push({ key: d.key, reason: 'the bundled document would not wire' });
      return { seeded, skipped };
    }

    const bundledHash = componentContentHash(d);
    const same = storedContentHash(current) === bundledHash;
    const broken = !versionWires(current);

    if (same) {
      skipped.push({ key: d.key, reason: 'the stored version is the bundled one' });
      return { seeded, skipped };
    }
    // Content HAS moved on. Only the platform's own versions are replaced.
    if (!broken && !isPlatformOwned(current)) {
      // Loud, because this is the state that hid the fixture-exclusion fix for
      // weeks: an operator-owned version that wires, silently frozen while the
      // bundled component fixed a defect underneath it.
      console.warn(
        `[mock2] built-in component ${d.key}: the bundled document differs from the stored v${current?.version} `
        + 'but that version is operator-owned, so it was NOT replaced. Re-import the bundled document to pick up '
        + 'platform fixes (the auth component\'s @fixture.invalid exclusion is one of them).',
      );
      skipped.push({ key: d.key, reason: 'operator-owned version differs from the bundle — not replaced' });
      return { seeded, skipped };
    }
    const version = insertComponentVersion(existing.id, {
      files: d.files, usage_md: d.usage_md, contract: d.contract,
      change_reason: broken
        ? 'Bundled update seeded at startup — the stored version could not wire the auth bootstrap (old imported document)'
        : 'Bundled update seeded at startup — the stored version was an older copy of the bundled component',
      source: 'import', createdBy: actor,
    });
    seeded.push({ key: d.key, as: 'new_version', version: version.version, reason: broken ? 'did not wire' : 'out of date' });
    console.log(`[mock2] upgraded built-in component ${d.key} to v${version.version} (${broken ? 'stored version could not wire the auth bootstrap' : 'stored version was out of date'})`);
  } catch (e) {
    console.warn(`[mock2] component seed failed for ${d.key}:`, e?.message);
  }
  return { seeded, skipped };
}
