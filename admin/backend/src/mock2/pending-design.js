// Fire-and-forget project start (migration 540): the design action queued
// WHILE the project is still provisioning, executed automatically the moment
// provisioning completes.
//
// The flow it fixes: create a project, type the idea into the design chat …
// and then sit watching the provision spinner because Send / Skip mockup are
// dead until the container is online. Now either action queues:
//   - design_send  → the brief runs as the first concept turn (mockup
//                    generation starts on its own; the user reviews the
//                    mockup whenever they come back — approval stays a
//                    human gate).
//   - skip_mockup  → the design stage is locked empty, and if the user also
//                    typed a brief it is queued as the first QUICK BUILD on
//                    the freshly deployed base app — type, tap, walk away,
//                    come back to a deployed app.
//
// One pending action per project (the latest wins). The doc is CONSUMED
// (cleared) before execution so a crash mid-run can never double-fire.
// Image attachments are saved to disk at queue time (bytes never sit in the
// project row) and re-hydrated at run time.
//
// Terminology (risk R7): nothing here is named "agent".

import { getProject, updateProject } from './projects.js';
import { saveChatImages, hydrateAttachments } from './chat-images.js';

export const PENDING_DESIGN_KINDS = Object.freeze(['design_send', 'skip_mockup']);

export function getPendingDesign(project) {
  try {
    return project?.pending_design_json ? JSON.parse(project.pending_design_json) : null;
  } catch { return null; }
}

// The compact shape the frontend renders ("Queued: … [cancel]") — never the
// full text or attachment bytes.
export function publicPendingDesignShape(doc) {
  if (!doc) return null;
  return {
    kind: doc.kind,
    mode: doc.mode || 'design',
    text_preview: String(doc.text || '').slice(0, 140),
    has_images: (doc.attachments || []).length > 0,
    created_at: doc.created_at || null,
  };
}

export function queuePendingDesign(projectId, { kind, text = '', mode = 'design', design = 'theme', images = [], userId = null }) {
  let attachments = [];
  try { attachments = saveChatImages(Number(projectId), images); } catch (e) { console.warn('[mock2] pending-design image save failed:', e?.message); }
  const doc = {
    kind, text: String(text || ''), mode, design, attachments,
    user_id: userId, created_at: new Date().toISOString(),
  };
  updateProject(Number(projectId), { pending_design_json: JSON.stringify(doc) });
  return doc;
}

export function clearPendingDesign(projectId) {
  updateProject(Number(projectId), { pending_design_json: null });
}

// Re-entrancy guard: the sweep below can be kicked from several places (end
// of provisioning + the project GET reconcile); consume-first plus this set
// makes double-fire impossible even under concurrent kicks.
const running = new Set();
export async function runPendingDesignSafe(projectId) {
  const pid = Number(projectId);
  if (running.has(pid)) return;
  running.add(pid);
  try { await runPendingDesign(pid); } finally { running.delete(pid); }
}

// Execute the queued action. Called at the END of provisioning (project is
// active; the base app deploy has been attempted) AND from the project GET
// reconcile — a backend restart mid-provision (an update.sh deploy) kills the
// in-flight provision function, so the tail hook alone left the queued action
// stored but never executed ("I had it queued, then it just disappeared").
// Never throws; every outcome lands in the chat.
export async function runPendingDesign(projectId) {
  const project = getProject(Number(projectId));
  const doc = getPendingDesign(project);
  if (!doc || !PENDING_DESIGN_KINDS.includes(doc.kind)) return;
  // Consume FIRST — a crash below must not re-fire on the next provision.
  clearPendingDesign(projectId);
  const { insertMessage } = await import('./chats.js');
  const say = (body) => { try { insertMessage({ projectId: Number(projectId), kind: 'system', body }); } catch { /* best effort */ } };
  const user = { id: doc.user_id };
  try {
    if (doc.kind === 'design_send') {
      const { startConceptTurn } = await import('./concept.js');
      const images = hydrateAttachments(Number(projectId), doc.attachments || []);
      const r = await startConceptTurn({
        project, message: doc.text, user, actingAsAdmin: 0,
        mode: doc.mode === 'plan' ? 'plan' : 'design',
        images, design: doc.design === 'explore' ? 'explore' : 'theme',
      });
      if (r.status === 'error' || r.status === 'refused') {
        say(`Your queued design message could not start automatically (${r.error || 'refused'}) — it is back in your hands: send it again from the design chat.`);
      } else {
        say('Provisioning finished — your queued design message is running now (the mockup generates in the background; review it here when it lands).');
      }
      return;
    }
    // skip_mockup: lock the design stage empty, then (if a brief was typed)
    // run it as the first quick build on the base app.
    const { skipDesign } = await import('./concept.js');
    const r = await skipDesign({ project, user, actingAsAdmin: 0 });
    if (r.status === 'error') {
      say(`Your queued "skip mockup" could not run automatically (${r.error}) — use Skip mockup in the design view.`);
      return;
    }
    if (String(doc.text || '').trim()) {
      const { enqueueBuild, drainBuildQueue } = await import('./build-queue.js');
      enqueueBuild({
        projectId: Number(projectId), instruction: doc.text.trim(),
        buildMode: 'quick', label: 'Queued at project creation', initiatedBy: doc.user_id,
      });
      say('Provisioning finished — mockup skipped as queued, and your typed request is now building as the first Quick update. Fire-and-forget complete: come back to a deployed app.');
      drainBuildQueue(Number(projectId)).catch((e) => console.warn('[mock2] pending-design drain failed:', e?.message));
    } else {
      say('Provisioning finished — mockup skipped as queued. The base app is yours: describe changes as Quick updates.');
    }
  } catch (e) {
    console.warn(`[mock2] pending design action failed for ${projectId}:`, e?.message);
    say(`Your queued design action failed to start automatically (${String(e?.message || e).slice(0, 200)}) — run it manually from the design view.`);
  }
}
