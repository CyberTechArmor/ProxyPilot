// Mock2 DESIGN FINDINGS — the native half (container read/write).
//
// See design-findings-logic.js for WHY. In short: the post-build design review
// posted its critique to the chat and stopped, so no finding ever reached the
// next build. This is the pair of calls that close that loop from the runner's
// side — read what is still open before a build's first turn, and record that
// the build was told.
//
// Everything here is best-effort and never throws: an offline project, a
// container without the file, a project that predates the ledger — all ordinary
// outcomes, all of which mean "no findings to brief" rather than "fail the
// build". A build must never fail because the design ledger was unreadable.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import {
  DESIGN_FINDINGS_PATH, parseFindingsLedger, renderFindingsLedger,
  openFindings, designFindingsSection, briefedKeys, markBriefed,
} from './design-findings-logic.js';

const APP_DIR = '/srv/app';

function containerSh(containerName, script, { timeoutMs = 20000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readLedger(containerName) {
  const r = await containerSh(containerName, `cat '${APP_DIR}/${DESIGN_FINDINGS_PATH}' 2>/dev/null`);
  return parseFindingsLedger(r.code === 0 ? (r.stdout || '') : '');
}

// buildDesignFindingsBrief(project) → { section, keys }.
//
// `section` rides the build's first turn (empty string when there is nothing
// open, so a project with a clean review pays zero tokens for this). `keys` is
// what to hand to markDesignFindingsBriefed once the build has actually
// started — see there for why that is a separate call.
export async function buildDesignFindingsBrief(project) {
  if (!project?.container_name || project.lifecycle !== 'active') return { section: '', keys: [] };
  try {
    const open = openFindings(await readLedger(project.container_name));
    return { section: designFindingsSection(open), keys: briefedKeys(open) };
  } catch (e) {
    console.warn(`[mock2] design findings brief failed for project ${project.id}:`, e?.message);
    return { section: '', keys: [] };
  }
}

// markDesignFindingsBriefed(project, keys) — record that a build was HANDED
// these findings.
//
// Separate from the read because the count means "builds that were told and
// shipped anyway", which is what decides when a finding stops riding every
// task turn. Counting at read time would mean a run that died before its first
// turn still burned a build's worth of patience.
export async function markDesignFindingsBriefed(project, keys = []) {
  if (!keys.length || !project?.container_name || project.lifecycle !== 'active') return false;
  try {
    const next = markBriefed(await readLedger(project.container_name), keys);
    // ENCODED payload on stdin — the script inside decodes it. A host-side
    // `base64 -d` in this pipeline decodes twice and writes garbage; see
    // base-app-upgrade.js's containerShWithStdin for the four bytes that cost.
    const script = `d="${APP_DIR}/${DESIGN_FINDINGS_PATH}"; mkdir -p "$(dirname "$d")"; base64 -d > "$d"`;
    const r = await sh(
      `incus exec ${project.container_name} -- sh -c "$(printf '%s' '${b64(script)}' | base64 -d)"`,
      { timeoutMs: 20000, input: b64(renderFindingsLedger(next)) },
    );
    return r.code === 0;
  } catch (e) {
    console.warn(`[mock2] design findings brief marking failed for project ${project.id}:`, e?.message);
    return false;
  }
}
