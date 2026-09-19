// Migration over MCP — move a running web application from another server,
// VM or container onto a ProxyPilot guest. Thin over lib/migration/service.js
// (shared with routes/migrations.js and the Migrations page), so a migration
// started from a chat and one started from the dashboard are the same row,
// with the same gates.
//
// The flow these six tools cover:
//
//   create_migration    → the one-line command the operator pastes on the
//                         source. Nothing is copied yet.
//   get_migration       → phases, bytes/rate/ETA, the inventory manifest
//                         (paths and KEY NAMES, never values), the concerns.
//   approve_migration   → after a human has read the inventory, let the
//                         transfer start (application mode creates the guest
//                         here, fenced).
//   migration_cutover   → the post-import checklist and the observed-egress
//                         decisions, both recorded with who and when.
//   list_migrations / cancel_migration
//
// The ledger row, the audit entry and the change record are written by
// kit.mutation; the service writes the migration's own event stream.

export function createMigrationHandlers(kit) {
  const { ctx, ok, err, mutation, reader, dry, confirmFlag } = kit;
  const svc = () => {
    const s = typeof ctx.migration === 'function' ? ctx.migration() : ctx.migration;
    if (!s) throw new Error('the migration service is not configured on this install');
    return s;
  };

  /* ------------------------------- readers ------------------------------ */

  const list_migrations = reader('list_migrations', async (args) => {
    const rows = svc().listMigrations({ status: args.status ? String(args.status) : null, limit: Number(args.limit) || 50 });
    return ok({
      count: rows.length, migrations: rows,
      agent_builds: await svc().agentBinaries(),
      note: 'create_migration returns the one-line command to run on the SOURCE host.',
    });
  });

  const get_migration = reader('get_migration', async (args) => {
    const row = svc().rowById(args.id);
    if (!row) return err(`no migration ${args.id} (list_migrations)`);
    const v = svc().view(row, { events: Math.max(0, Math.min(500, Number(args.events) ?? 50)) });
    if (args.manifest === false) v.manifest = undefined;
    return ok({
      ...v,
      next: nextStepHint(v),
      note: 'The manifest carries .env PATHS and KEY NAMES only — ProxyPilot refuses a manifest that carries a value, so the secrets are still only on the source. Type them in with set_project_env after cutover step "secrets_entered".',
    });
  });

  function nextStepHint(v) {
    if (v.status === 'created') return `Run this on the source host: the command create_migration printed. The token expires ${v.token.expires_at}.`;
    if (v.status === 'awaiting_review') return `Review the inventory (${v.concerns.filter((c) => c.level === 'block').length} blocking concern(s)), then approve_migration({ id: ${v.id}, confirm: true }).`;
    if (v.status === 'running') return `Transfer in progress: ${v.progress.percent ?? '?'}% (${v.progress.rate_bps ? `${Math.round(v.progress.rate_bps / 1024 / 1024)} MiB/s` : 'rate unknown'}${v.progress.stalled ? ', STALLED' : ''}).`;
    if (v.status === 'ready') return `Work the checklist: ${v.checklist_progress.remaining.join(', ')} — migration_cutover({ id: ${v.id}, step: "<id>" }).`;
    if (v.status === 'completed') return 'Done: every required cutover step is recorded.';
    return v.error || `status ${v.status}`;
  }

  /* ------------------------------ mutations ----------------------------- */

  const create_migration = mutation('create_migration', { subjectType: 'migration', flag: 'mcp.migration', audit: 'MIGRATION_CREATE', keepArgs: ['dry_run', 'confirm'] }, async (args, auth, req, note) => {
    const { dry_run, confirm, ttl_seconds, ...input } = args;
    if (dry_run === true) {
      const { validateTarget, installCommand } = await import('../../lib/migration/plan.js');
      const v = validateTarget(input);
      if (v.error) { note.refused = true; return err(v.error); }
      return ok({ dry_run: true, would: { spec: v.spec, guest: `pp-${v.spec.name}`, command: installCommand({ baseUrl: '<this ProxyPilot>', token: '<minted on the real call>' }) }, note: 'Nothing was created and no token was minted.' });
    }
    const gate = confirmFlag(args, note, `This mints a single-use migration token and prints a command to run as ROOT on the source host. Nothing is copied until you approve the inventory.`);
    if (gate) return gate;
    const r = await svc().createMigration({ input, actor: auth?.created_by ?? null, ttlSeconds: ttl_seconds });
    if (r.error) { note.refused = true; return err(r.error); }
    note.subject_id = r.migration.id;
    note.summary = `migration ${r.migration.id} created (${r.migration.mode} → ${r.migration.target.incus_name})`;
    // The token is the credential: it is shown to the caller once and never
    // written to the ledger (redactArgs cannot help here — this is a RESULT).
    note.detail = { mode: r.migration.mode, transport: r.migration.transport, target: r.migration.target.incus_name, token_id: r.migration.token.id };
    return ok({
      migration: r.migration, command: r.command, command_steps: r.command_steps,
      expires_at: r.expires_at, tls_pin: r.tls_pin,
      next: 'Give the operator the command verbatim and tell them to run it as root ON THE SOURCE. Then poll get_migration: the inventory arrives first and the transfer waits for approve_migration.',
      warning: r.tls_pin ? null : 'No TLS pin could be computed for this ProxyPilot (no https certificate was reachable) — the agent will fall back to the system trust store.',
    });
  });

  const approve_migration = mutation('approve_migration', { subjectType: 'migration', flag: 'mcp.migration', audit: 'MIGRATION_APPROVE' }, async (args, auth, req, note) => {
    const row = svc().rowById(args.id);
    if (!row) return err(`no migration ${args.id}`);
    note.subject_id = row.id;
    const v = svc().view(row);
    if (!v.manifest_at) { note.refused = true; return err('the inventory has not arrived yet — there is nothing to review'); }
    const blocking = v.concerns.filter((c) => c.level === 'block');
    const plan = { migration: row.id, target: row.target_name, mode: row.mode, transport: row.transport, summary: v.summary, concerns: v.concerns, egress_observed: v.egress.length, routes: v.routes };
    const d = dry(args, plan); if (d) return d;
    if (blocking.length && args.override_blocking !== true) {
      note.refused = true;
      return err(`refused: ${blocking.map((b) => b.text).join(' ')} Pass override_blocking: true only if you have read the inventory and know why it is wrong.`, { concerns: v.concerns });
    }
    const gate = confirmFlag(args, note, `This starts copying ${v.summary?.hostname || 'the source'} into ${row.target_name}${row.mode === 'application' ? ' (the guest is created now, fenced)' : ''}.`);
    if (gate) return gate;
    const r = await svc().approveTransfer(row.id, { actor: auth?.created_by ?? null });
    if (r.error) { note.refused = true; return err(r.error); }
    note.summary = `approved the transfer for migration ${row.id}`;
    return ok({ ...r, next: 'The agent starts within a few seconds. Poll get_migration for bytes, rate and ETA.' });
  });

  const migration_cutover = mutation('migration_cutover', { subjectType: 'migration', flag: 'mcp.migration', audit: 'MIGRATION_CUTOVER' }, async (args, auth, req, note) => {
    const row = svc().rowById(args.id);
    if (!row) return err(`no migration ${args.id}`);
    note.subject_id = row.id;
    const action = args.action === 'egress' ? 'egress' : 'step';
    if (action === 'egress') {
      const plan = { migration: row.id, host: args.host, port: args.port ?? null, decision: args.decision || 'approve' };
      const d = dry(args, plan); if (d) return d;
      const r = await svc().decideEgress(row.id, { host: args.host, port: args.port ?? null, decision: args.decision === 'deny' ? 'deny' : 'approve', by: auth?.created_by ?? 'mcp' });
      if (r.error) { note.refused = true; return err(r.error); }
      note.summary = `egress ${r.entry.decision} for ${r.entry.host} on migration ${row.id}`;
      return ok({ entry: r.entry, egress: r.egress });
    }
    const step = String(args.step || '');
    const done = args.done !== false;
    const plan = { migration: row.id, step, done, note: args.note || null };
    const d = dry(args, plan); if (d) return d;
    const r = svc().setChecklistStep(row.id, { step, done, by: auth?.created_by ?? 'mcp', note: args.note ? String(args.note) : null });
    if (r.error) { note.refused = true; return err(r.error); }
    note.summary = `${done ? 'completed' : 'reopened'} cutover step ${step} on migration ${row.id}`;
    return ok({
      checklist: r.migration.checklist, progress: r.migration.checklist_progress, complete: r.complete,
      next: r.complete ? 'Every required step is done — the migration is complete.' : `Remaining: ${r.migration.checklist_progress.remaining.join(', ')}`,
    });
  });

  const cancel_migration = mutation('cancel_migration', { subjectType: 'migration', flag: 'mcp.migration', audit: 'MIGRATION_CANCEL' }, async (args, auth, req, note) => {
    const row = svc().rowById(args.id);
    if (!row) return err(`no migration ${args.id}`);
    note.subject_id = row.id;
    const d = dry(args, { migration: row.id, target: row.target_name, status: row.status }); if (d) return d;
    const gate = confirmFlag(args, note, `This stops migration ${row.id} and kills its token. Any guest already created is left exactly as it is — cancelling never deletes data.`);
    if (gate) return gate;
    const r = await svc().cancelMigration(row.id, { actor: auth?.created_by ?? null, reason: args.reason ? String(args.reason) : null });
    if (r.error) { note.refused = true; return err(r.error); }
    note.summary = `cancelled migration ${row.id}`;
    return ok(r);
  });

  return { create_migration, get_migration, list_migrations, approve_migration, migration_cutover, cancel_migration };
}
