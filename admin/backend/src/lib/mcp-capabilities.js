// Small workflow index over the actual, scope-filtered MCP catalog. This is
// navigation, not authority: tool dispatch still enforces scopes and flags.
export const MCP_WORKFLOWS = Object.freeze([
  { id: 'applications', title: 'Existing application Git and releases', keywords: 'nodus existing application recovery commit branch merge deploy release rollback git gitea github source snapshot', tools: ['list_applications', 'get_application', 'register_application', 'checkpoint_application', 'inspect_application_source', 'commit_application_changes', 'prepare_application_release', 'validate_application_release', 'publish_application_release', 'verify_application_remote', 'deploy_application_release', 'verify_application_release', 'rollback_application_release', 'merge_application_release', 'get_application_job'] },
  { id: 'project-files', title: 'Inspect and change project source', keywords: 'code files edit search read source project workspace', tools: ['project_map', 'search_project_files', 'read_project_files', 'apply_project_patch', 'run_project_command', 'redeploy_project'] },
  { id: 'git-publication', title: 'Directory snapshot publication', keywords: 'snapshot export push remote git gitea github', tools: ['list_git_connectors', 'get_git_remote', 'set_git_remote', 'push_git_remote', 'verify_git_remote'] },
  { id: 'self-update', title: 'Update ProxyPilot from tested source', keywords: 'proxypilot self update github commit deploy build', tools: ['get_self_status', 'prepare_self_from_git', 'read_self_file', 'apply_self_patch', 'run_self_checks', 'promote_self', 'adopt_self_git_commit', 'get_proxypilot_update_status', 'rollback_self'] },
  { id: 'containers', title: 'Inspect containers and durable setup jobs', keywords: 'lxc incus container job logs resources', tools: ['list_lxc_containers', 'get_lxc_container', 'get_lxc_setup_job', 'list_lxc_setup_jobs', 'get_host_usage'] },
  { id: 'platform', title: 'Platform setup and service readiness', keywords: 'platform sso keycloak openbao pomerium vault infisical', tools: ['get_platform_setup', 'get_platform_service', 'platform_preflight', 'apply_platform_setup', 'get_platform_job'] },
  { id: 'migration', title: 'Adopt an application or machine', keywords: 'migrate migration import adopt move machine', tools: ['list_migrations', 'create_migration', 'get_migration', 'approve_migration', 'migration_cutover'] },
  { id: 'app-storage', title: 'Application storage check (read-only)', keywords: 'storage disk space usage grow growth cleanup clean application nodus project check', tools: ['list_application_storage', 'request_application_storage_check', 'get_application_storage_check'] },
  { id: 'storage', title: 'Storage plans and backups', keywords: 'storage zfs disks backup restore snapshot', tools: ['list_disks', 'zpool_status', 'zfs_list', 'list_host_snapshots', 'backup_proxypilot_db'] },
]);

export function discoverCapabilities(catalog, { query = '', limit = 12, includeSchemas = false } = {}) {
  const terms = String(query).toLowerCase().match(/[a-z0-9_]+/g) || [];
  const cap = Math.max(1, Math.min(30, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 12));
  const byName = new Map(catalog.map(t => [t.name, t]));
  const score = text => terms.reduce((n, t) => n + (text.toLowerCase().includes(t) ? 1 : 0), 0);
  const workflows = MCP_WORKFLOWS.map(w => ({ ...w, score: score(`${w.title} ${w.keywords}`), tools: w.tools.filter(n => byName.has(n)) }))
    .filter(w => w.tools.length && (!terms.length || w.score > 0)).sort((a, b) => b.score - a.score)
    .map(({ id, title, tools }) => ({ id, title, tools, first_tool: tools[0] }));
  const selected = new Set(workflows.flatMap(w => w.tools));
  const matches = catalog.map(t => ({ ...t, score: score(`${t.name} ${t.description}`) }))
    .filter(t => selected.has(t.name) || (terms.length && t.score > 0))
    .sort((a, b) => Number(selected.has(b.name)) - Number(selected.has(a.name)) || b.score - a.score);
  return {
    query: String(query), available_tool_count: catalog.length, workflows,
    tools: matches.slice(0, cap).map(({ name, description, inputSchema }) => ({ name, description, ...(includeSchemas ? { inputSchema } : {}) })),
    has_more: matches.length > cap,
    guidance: 'Only tools permitted by this key are listed. Discovery grants no permissions. Runtime flags, resource checks and confirmation still apply. Inspect returned schemas, then follow the tool result next_actions. A successful push is not independent remote verification, a passing test is not deployment, and a healthy response alone is not feature acceptance.',
  };
}
