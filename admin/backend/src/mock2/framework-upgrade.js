// The seed-upgrade publish ("framework seed → published version"), native-free.
// framework.js binds it to mock2.db; the tests bind it to an in-memory store, so
// the same function is exercised end to end without better-sqlite3.
//
// What it publishes: the vendored seed's five content fields, with the
// constitution's pinned Mock2 guidance block rendered from the ACTIVE guidance
// (the seed's own, or a verified newer release from the standards site —
// active-guidance.js / live-guidance.js).
//
// The guidance floor: when the latest published version already carries NEWER
// guidance than this process can render (its pinned block names a version above
// the active one — e.g. the live cache was lost or ignored at boot), that block
// is kept as published and only the platform sections follow the seed. So a
// restart never republishes older guidance; the live check re-fetches the
// release. allowGuidanceDowngrade (reset_to_seed) is the one deliberate way down.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getActiveGuidance, effectiveConstitution } from './active-guidance.js';
import { seedUpgradeProvenance } from './framework-logic.js';
import { compareGuidanceVersions, keepPinnedBlock, pinnedGuidanceVersion } from './guidance-release-logic.js';

export const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'framework-seed');

export function readSeedFile(name) {
  return readFileSync(resolve(SEED_DIR, name), 'utf8');
}

// The seed's five content fields with the active guidance's pinned block, or
// null if any file is unreadable.
export function readSeedContent(active = getActiveGuidance(), { readFile = readSeedFile, log = console } = {}) {
  try {
    return {
      constitution_md: effectiveConstitution(readFile('constitution.md'), active),
      skills_json: readFile('skills.json'),
      gates_json: readFile('gates.json'),
      design_system_md: readFile('design-system.md'),
      project_template_ref: readFile('project-template.ref').trim(),
    };
  } catch (err) {
    log.error?.('[mock2] framework seed: could not read vendored seed:', err?.message);
    return null;
  }
}

const sameContent = (latest, content) => latest.constitution_md === content.constitution_md
  && latest.skills_json === content.skills_json
  && latest.gates_json === content.gates_json
  && latest.design_system_md === content.design_system_md
  && String(latest.project_template_ref || '') === content.project_template_ref;

/**
 * createSeedUpgrader({ getCurrent, insert, resolveAuthor, readFile, log }) →
 * upgradeFrameworkFromSeed(createdBy, active, { allowGuidanceDowngrade, resetFrom })
 * returning the inserted row, or null when nothing changed.
 */
export function createSeedUpgrader({ getCurrent, insert, resolveAuthor = (id) => id ?? 1, readFile = readSeedFile, log = console }) {
  return function upgradeFrameworkFromSeed(createdBy = null, active = getActiveGuidance(), { allowGuidanceDowngrade = false, resetFrom = null } = {}) {
    const latest = getCurrent();
    if (!latest) return null; // nothing seeded yet — first boot goes through seedFrameworkV1
    let content = readSeedContent(active, { readFile, log });
    if (!content) return null;
    const published = pinnedGuidanceVersion(latest.constitution_md);
    let kept = null;
    if (!allowGuidanceDowngrade && published && compareGuidanceVersions(published, active.version) > 0) {
      content = { ...content, constitution_md: keepPinnedBlock(content.constitution_md, latest.constitution_md) };
      kept = published;
    }
    if (sameContent(latest, content)) return null;
    const row = insert({
      ...content,
      ...seedUpgradeProvenance(active, latest.version, { kept, resetFrom }),
      createdBy: resolveAuthor(createdBy),
    });
    log.log?.(active?.origin === 'site' && !kept
      ? `[mock2] framework upgraded from live guidance → version ${row.version} (Mock2 ${active.version} from ${active.site})`
      : `[mock2] framework upgraded from seed → version ${row.version} (seed content changed since v${latest.version}${kept ? `; kept published guidance ${kept}` : ''}${resetFrom ? `; reset from live guidance ${resetFrom}` : ''})`);
    return row;
  };
}
