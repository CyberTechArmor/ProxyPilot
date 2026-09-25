// Migration 706 permanently retires Lean BEAF data. Keep migrations 700–705
// unchanged so existing migration histories and fresh installs converge.
// No filesystem, credential decryption, provider or infrastructure calls.
export function retireLeanBeaf(d) {
  // Explicit allowlist, children before parents. No prefix-based table drops.
  const tables = [
    'lbp_scope_pods', 'lbp_rollout_scopes', 'lbp_project_assignees',
    'lbp_activity', 'lbp_metric_reports', 'lbp_time_events', 'lbp_feedback',
    'lbp_learnings', 'lbp_files', 'lbp_project_links', 'lbp_tasks',
    'lbp_blockers', 'lbp_brief_runs', 'lbp_schedules', 'lbp_meeting_schedules',
    'lbp_meeting_markers', 'lbp_metric_definitions', 'lbp_projects',
    'lbp_locations', 'lbp_workspaces',
  ];
  for (const table of tables) d.exec(`DROP TABLE IF EXISTS ${table}`);
  const remove = d.prepare('DELETE FROM app_settings WHERE key = ?');
  for (const key of ['lbp_connections', 'lbp_brief_model', 'lbp_brief_api_key_enc', 'lbp_brief_base_url']) {
    remove.run(key);
  }
  // Global audit and schema_migrations records remain. Uploaded files need a
  // separately reviewed cleanup of the actual deployed directory; see docs.
}
