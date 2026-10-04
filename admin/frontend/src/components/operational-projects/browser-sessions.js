// The runtime currently admits one isolated attempt. This read model never
// opens a viewer, loads private inputs or starts a browser.
export const SESSION_PROJECT_BATCH = 6;
const active = new Set(['preparing', 'running', 'paused', 'awaiting_approval', 'human_control', 'stopping']);
export const isActiveSession = run => active.has(run.state);
export function sessionGroup(run) {
  if (run.uncertain || ['awaiting_approval', 'human_control', 'uncertain'].includes(run.state)) return 'help';
  if (run.state === 'paused') return 'paused';
  if (active.has(run.state)) return 'running';
  return 'ended';
}
const labels = { preparing: 'Preparing', running: 'Running', paused: 'Paused', awaiting_approval: 'Needs review', human_control: 'Human control', stopping: 'Stopping', completed: 'Completed', cancelled: 'Stopped', failed: 'Failed', uncertain: 'Needs reconciliation' };
export const sessionStateLabel = run => run.uncertain ? 'Needs reconciliation' : labels[run.state] || 'Unknown state';
export function sessionDescription(run) {
  if (run.uncertain) return 'An effect or cleanup remains unverified. Inspect the recorded evidence.';
  return ({preparing:'The isolated browser is preparing.', running:run.execution_mode === 'public_navigation' ? 'Public website browsing is active.' : 'The configured browser task is running.', paused:'The task is paused.', awaiting_approval:'A request is waiting for your review.', human_control:'The browser is under human control.', stopping:'Stop was requested. Cleanup is being checked.', completed:'The run ended with a recorded result.', cancelled:'The run was stopped. Inspect its cleanup receipt.', failed:'The run could not finish. Inspect its outcome and recovery.', uncertain:'An effect or cleanup needs reconciliation.'})[run.state] || 'Inspect this recorded run for its current state.';
}
export function sessionRunUrl(projectId, runId) {
  return `/operational-projects/${encodeURIComponent(projectId)}?section=Agents&browser_run=${encodeURIComponent(runId)}`;
}
export function sessionCounts(rows) {
  const counts = {all:rows.length, help:0, running:0, paused:0, ended:0, active:0};
  for (const {run} of rows) {counts[sessionGroup(run)]++; if (isActiveSession(run)) counts.active++;}
  return counts;
}
export function canPrepareSession(project) {
  return !project.archived_at && ['owner','operator','editor','reviewer'].includes(project.own_role);
}
export async function loadSessionBatch(api, after, signal) {
  const page = await api.get(`?state=all&limit=${SESSION_PROJECT_BATCH}${after ? `&after=${encodeURIComponent(after)}` : ''}`, signal);
  // The project API supplies membership-scoped records and explicit pagination.
  // The run API supplies at most the latest 50 runs per project, without a
  // cursor. Do not pretend this is an exhaustive installation-wide inventory.
  const projects = page.projects.slice(0, SESSION_PROJECT_BATCH);
  const outcomes = await Promise.allSettled(projects.map(project => api.get(`/${encodeURIComponent(project.id)}/browser-agent-runs`, signal)));
  const denied = outcomes.find(result => result.status === 'rejected' && result.reason.status === 401);
  if (denied) throw denied.reason;
  const rows = [], failures = [];
  outcomes.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      for (const run of (result.value.runs || []).slice(0,50)) rows.push({project:projects[index],run});
    } else failures.push({projectId:projects[index].id, message:[403,404].includes(result.reason.status) ? 'Run access is unavailable. Refresh to recheck your permissions.' : 'Run records could not be loaded. Refresh to retry.'});
  });
  return {projects:projects.filter((_,index)=>outcomes[index].status==='fulfilled'||![403,404].includes(outcomes[index].reason.status)), rows, failures, cursor:page.next_cursor || null};
}
