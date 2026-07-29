// Mock2 automatic framework adoption — the PURE decision layer.
//
// ADR-003 shipped explicit-consent adoption: when the framework moved, every
// project showed an "update available" banner and waited for an operator to
// press "Start update cycle". Operator report: nobody wants that job — the
// banner nagged on every project after every publish, and a project whose
// operator missed it kept building against a constitution the install had
// moved past. Adoption is now AUTOMATIC by default (ADR-003 amendment; the
// framework_auto_adopt setting is the off switch): a background sweep starts
// the SAME update cycle the button started, when the project is idle and
// online. New builds always pinned the current version anyway — this only
// closes the gap where a finished app sat unreconciled because nobody pressed
// the button.
//
// PURE (stub-first, risk R9): no I/O, no native modules. Terminology (risk
// R7): nothing here is named "agent".

// Cycle statuses that mean "someone or something is mid-flight on this
// project" — the sweep never starts an adoption over live work.
export const ACTIVE_CYCLE_STATUSES = Object.freeze([
  'queued', 'estimating', 'running', 'awaiting_user', 'awaiting_admin', 'paused',
]);

// The update-cycle instruction — the same shape the manual "Start update
// cycle" button (BuildMode.remediate) composes, so the automatic and manual
// paths cannot drift apart in what they ask the build to do.
export function adoptInstruction(fromVersion, toVersion) {
  const from = fromVersion ? `v${fromVersion} → ` : '';
  return `Adopt framework ${from}v${toVersion}: re-run the full gate battery and reconcile the app with the updated constitution and confirmed rules (Mock2 ${from}v${toVersion}).`;
}

// shouldAutoAdopt(facts) → { adopt, reason }
//
// Deliberately conservative — the sweep may only start a cycle the operator
// could have started with the button, and only ONCE per framework version:
//  * enabled          — the framework_auto_adopt setting is on
//  * online + approved — the project is 'active' and past design sign-off
//  * has built before  — a project with no first build has nothing to
//    reconcile (its first build pins current on its own)
//  * actually behind   — last-built framework ≠ current
//  * idle              — no live/blocked cycle, nothing holding the checkout lock
//  * not yet attempted — no cycle already pins the current version. Every
//    cycle (including a refused or failed adoption) pins at start, so this is
//    the idempotency latch: a failing adoption never retries itself forever
//    on someone's bill.
export function shouldAutoAdopt({
  enabled = true,
  project = {},
  currentFrameworkId = null,
  latestCycleStatus = null,
  hasCycleOnCurrent = false,
  lockHeld = false,
} = {}) {
  if (!enabled) return { adopt: false, reason: 'auto-adopt off' };
  if (!currentFrameworkId) return { adopt: false, reason: 'no framework version' };
  if (project.lifecycle !== 'active') return { adopt: false, reason: `project ${project.lifecycle || 'missing'}` };
  if (!project.design_approved_at) return { adopt: false, reason: 'design not approved' };
  if (!project.last_built_framework_version_id) return { adopt: false, reason: 'never built' };
  if (Number(project.last_built_framework_version_id) === Number(currentFrameworkId)) {
    return { adopt: false, reason: 'up to date' };
  }
  if (latestCycleStatus && ACTIVE_CYCLE_STATUSES.includes(latestCycleStatus)) {
    return { adopt: false, reason: `cycle ${latestCycleStatus}` };
  }
  if (lockHeld) return { adopt: false, reason: 'checked out' };
  if (hasCycleOnCurrent) return { adopt: false, reason: 'already attempted this version' };
  return { adopt: true, reason: 'drifted' };
}

// The chat notice posted when the sweep starts an adoption, so the build that
// appears in the project's history explains itself.
export function adoptChatNotice(fromVersion, toVersion) {
  const from = fromVersion ? `v${fromVersion} → ` : '';
  return `Framework updated (${from}v${toVersion}) — starting the update cycle automatically to reconcile the app with it. `
    + 'Automatic adoption can be turned off in the Framework admin page.';
}
