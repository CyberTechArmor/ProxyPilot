// Mock2 automatic framework adoption — the native half (sweep + start).
//
// The DECISION is pure (auto-adopt-logic.js, unit-tested); this module gathers
// the facts (projects behind the current framework, their latest cycle, the
// checkout lock) and, for each eligible project, starts the SAME update cycle
// the manual "Start update cycle" button starts — through audit.startBuild, so
// quota checks, the audit gate, and every runner behavior are identical to the
// manual path. Registered from index.js: once on boot (after the seed upgrade
// may have published a new version) and on a slow interval.
//
// Idempotency is structural: every cycle pins the current framework version at
// start, and shouldAutoAdopt refuses when any cycle already pins it — so each
// project gets at most ONE automatic attempt per published version, even if
// that attempt is refused (quota) or fails.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { getDb } from '../db.js';
import { getCurrentFrameworkVersion, getFrameworkVersion } from './framework.js';
import { getProject } from './projects.js';
import { getLock } from './locks.js';
import { insertMessage, getOrCreateChat } from './chats.js';
import { startBuild, readProjectFile } from './audit.js';
import { countConfirmedRules } from './audit-logic.js';
import { RULES_PATH } from './rules-view-logic.js';
import { containerNameForProject } from './provision.js';
import { getFrameworkAutoAdopt } from './settings.js';
import { shouldAutoAdopt, adoptInstruction, adoptChatNotice } from './auto-adopt-logic.js';

// Re-entrancy latch: a sweep can await several startBuild calls; the interval
// must not stack a second sweep on top of a slow first one.
let sweeping = false;

// sweepFrameworkAutoAdopt() → { checked, started } (best-effort; never throws).
export async function sweepFrameworkAutoAdopt() {
  if (sweeping) return { checked: 0, started: 0 };
  sweeping = true;
  try {
    if (!getFrameworkAutoAdopt()) return { checked: 0, started: 0 };
    const framework = getCurrentFrameworkVersion();
    if (!framework) return { checked: 0, started: 0 };
    const db = getMock2Db();
    // Cheap pre-filter in SQL; the authoritative decision is shouldAutoAdopt.
    const behind = db.prepare(
      `SELECT id FROM mock2_projects
        WHERE lifecycle = 'active'
          AND design_approved_at IS NOT NULL
          AND last_built_framework_version_id IS NOT NULL
          AND last_built_framework_version_id != ?`,
    ).all(framework.id);
    let started = 0;
    for (const row of behind) {
      try {
        if (await maybeAdoptProject(row.id, framework)) started += 1;
      } catch (err) {
        console.warn(`[mock2] framework auto-adopt failed for project ${row.id}:`, err?.message || err);
      }
    }
    return { checked: behind.length, started };
  } catch (err) {
    console.warn('[mock2] framework auto-adopt sweep failed:', err?.message || err);
    return { checked: 0, started: 0 };
  } finally {
    sweeping = false;
  }
}

async function maybeAdoptProject(projectId, framework) {
  const db = getMock2Db();
  const project = getProject(projectId);
  if (!project) return false;
  const latest = db.prepare(
    `SELECT status FROM mock2_cycles WHERE project_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(project.id);
  const onCurrent = db.prepare(
    `SELECT COUNT(*) AS n FROM mock2_cycles WHERE project_id = ? AND framework_version_id = ?`,
  ).get(project.id, framework.id);
  let lockHeld = false;
  try {
    const lock = getLock(project.id);
    lockHeld = !!(lock && (lock.holder_cycle_id != null || lock.holder_user_id != null));
  } catch { lockHeld = false; }

  const verdict = shouldAutoAdopt({
    enabled: true, // the sweep-level switch was already consulted
    project,
    currentFrameworkId: framework.id,
    latestCycleStatus: latest?.status || null,
    hasCycleOnCurrent: (onCurrent?.n || 0) > 0,
    lockHeld,
  });
  if (!verdict.adopt) return false;

  // Define-stage enforcement consequence (run-taxonomy fix #4/C2.6): every
  // auto-adopt candidate has built before (the SQL pre-filter requires
  // last_built_framework_version_id), so the C2.4 pre-build block would apply
  // to all of them. Auto-adopt starts FULL builds, and a full build with no
  // confirmed rules would just refuse loudly — a fleet-wide wave of "Build
  // not started" the first time this ships. Skip those projects quietly
  // instead (reversible: the next sweep after Define is run picks them back
  // up). Fails open on a container read error — a hiccup here must not stall
  // adoption for every project.
  try {
    const containerName = project.container_name || containerNameForProject(project.id);
    const rulesRead = await readProjectFile(containerName, RULES_PATH);
    const confirmed = rulesRead.ok ? countConfirmedRules(rulesRead.content) : 0;
    if (confirmed === 0) {
      console.log(`[mock2] framework auto-adopt: skipping project ${project.id} — no confirmed rules yet (run Define first).`);
      return false;
    }
  } catch (e) {
    console.warn(`[mock2] framework auto-adopt: rule-check failed for project ${project.id} (proceeding):`, e?.message);
  }

  const from = project.last_built_framework_version_id
    ? getFrameworkVersion(project.last_built_framework_version_id)
    : null;
  const instruction = adoptInstruction(from?.version, framework.version);
  const initiator = platformAdminId();

  // Say WHY a build the operator never asked for is starting, before it starts.
  try {
    getOrCreateChat(project.id);
    insertMessage({ projectId: project.id, kind: 'system', body: adoptChatNotice(from?.version, framework.version) });
  } catch { /* the notice is best-effort; the build is the point */ }

  const res = await startBuild({
    project, instruction, user: { id: initiator }, actingAsAdmin: 1, buildMode: 'full',
  });
  if (res.status === 'started') {
    console.log(`[mock2] framework auto-adopt: update cycle started for project ${project.id} (v${from?.version ?? '?'} → v${framework.version})`);
    return true;
  }
  // A refusal/error is terminal for this version (the refused cycle pins it) or
  // transient (lock/audit races — retried by the next sweep via the guards).
  console.warn(`[mock2] framework auto-adopt: not started for project ${project.id}: ${res.error || res.status}`);
  return false;
}

// The initiator recorded on automatic adoption cycles: the install's first
// admin (same resolution the framework seed uses) — a real users row, so
// request/cycle attribution never dangles.
function platformAdminId() {
  try {
    const admin = getDb().prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1`).get();
    return admin?.id ?? 1;
  } catch { return 1; }
}
