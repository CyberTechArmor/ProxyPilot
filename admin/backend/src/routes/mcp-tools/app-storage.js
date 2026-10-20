// Application storage over MCP: three read-only tools. Requesting a check is
// recorded (ledger + audit) but changes nothing on the guest. There is no
// cleanup or policy verb here, by design — those are dashboard-only.

const MEMBERS_SHOWN = 50;

function projectCheck(check) {
  return {
    ...check,
    items: (check.items || []).map((it) => (it.kind === 'group' && Array.isArray(it.members) && it.members.length > MEMBERS_SHOWN
      ? { ...it, members: it.members.slice(0, MEMBERS_SHOWN), membersTruncated: true }
      : it)),
  };
}

export function createAppStorageHandlers(kit) {
  const { ctx, reader, mutation, ok, err } = kit;
  // Read-only facade: only these four methods are ever called from MCP.
  const storage = async () => {
    if (ctx.appStorage) return typeof ctx.appStorage === 'function' ? ctx.appStorage() : ctx.appStorage;
    if (!ctx.mock2Enabled()) throw new Error('Dev Studio is disabled on this install, so application storage is unavailable');
    return (await import('../../lib/app-storage/index.js')).getAppStorage();
  };
  return {
    list_application_storage: reader('list_application_storage', async () => {
      const s = await storage();
      return ok({ ...(await s.overview()), next_actions: [{ tool: 'request_application_storage_check', purpose: 'Measure one application or project now (read-only)' }, { tool: 'get_application_storage_check', purpose: 'Read the latest check of one target' }] });
    }),
    get_application_storage_check: reader('get_application_storage_check', async (args) => {
      const s = await storage();
      const check = args.check_id ? s.getCheck(String(args.check_id)) : s.latestCheck(String(args.target_key));
      if (!check) return err(args.check_id ? 'That storage check does not exist (only the newest 20 per target are kept).' : 'No finished storage check yet; request one with request_application_storage_check.');
      if (check.target?.key && check.target.key !== args.target_key) return err('That check belongs to another application or project.');
      return ok(projectCheck(check));
    }),
    request_application_storage_check: mutation('request_application_storage_check', { subjectType: 'app_storage' }, async (args, auth, req, note) => {
      const s = await storage();
      note.subject_id = String(args.target_key);
      const r = s.requestCheck(String(args.target_key), { origin: 'mcp', requestedBy: `mcp:${auth?.id ?? 'unknown'}` });
      note.summary = r.reused ? 'storage check already running' : 'storage check requested';
      note.detail = { check_id: r.checkId, reused: r.reused };
      return ok({ ...r, read_only: true, next_actions: [{ tool: 'get_application_storage_check', arguments: { target_key: args.target_key, check_id: r.checkId }, purpose: 'Read the result once its status is complete or partial (a check takes up to about two minutes)' }] });
    }),
  };
}
