import { approvalPayload } from './browser-agent-ui.js';

export const approvalKey = (approval, run) => JSON.stringify([run.id, run.attempt_id, run.fence, approval.id, approval.action_sha256]);
export function approvalBlocker(approval, now = Date.now()) {
  if (approval.state !== 'pending' || !Number.isFinite(Date.parse(approval.expires_at)) || Date.parse(approval.expires_at) <= now) return 'This request expired or changed. Refresh the run.';
  if (approval.kind !== 'consequential_action' && !approval.purpose) return 'The request needs an exact purpose before approval.';
  if (['network_effect','off_list_destination'].includes(approval.kind) && approval.no_contact !== true) return 'Before-contact proof is missing. You can deny this request.';
  return null;
}

// The existing API authorizes individual requests, not a blanket batch grant.
// Re-read after every decision because the runner can consume/invalidate others.
export async function submitReviewBatch({ snapshot, choices, root, client, signal, onData }) {
  const original = snapshot.run;
  const selected = snapshot.pending_approvals.map(approval => ({ approval, decision: choices[approvalKey(approval, original)] }));
  if (!selected.length || selected.some(item => !['approve','deny'].includes(item.decision))) throw new Error('Choose Approve or Deny for every request.');
  // Denial may pause the runner and invalidate remaining approvals, so submit it last.
  selected.sort((a,b) => Number(a.decision === 'deny') - Number(b.decision === 'deny'));
  let current;
  for (const { approval, decision } of selected) {
    current = await client.get(root, signal); onData(current);
    if (current.run.id !== original.id || current.run.attempt_id !== original.attempt_id || current.run.fence !== original.fence) throw new Error('The browser attempt changed. Review its current requests before submitting again.');
    const fresh = current.pending_approvals.find(item => item.id === approval.id && item.action_sha256 === approval.action_sha256);
    if (!fresh || fresh.state !== 'pending') throw new Error('A request changed while decisions were being submitted. Review the remaining requests. Earlier decisions are saved.');
    if (!current.controls?.can_approve) throw new Error('Your session cannot decide this request. Verify your session and review again.');
    if (decision === 'approve' && approvalBlocker(fresh)) throw new Error(approvalBlocker(fresh));
    await client.write(`${root}/approvals/${fresh.id}/decision`, approvalPayload(fresh,current.run,decision),current.run.revision,'POST',signal);
    current = await client.get(root,signal); onData(current);
  }
  if (current.pending_approvals.length || current.uncertainties?.some(item => item.state === 'unresolved')) throw new Error('New requests or outcomes need your review. Your submitted decisions are saved.');
  return current;
}
