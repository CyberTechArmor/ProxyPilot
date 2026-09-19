// Storage over MCP — host block devices, ZFS pools/datasets/snapshots, the
// Incus binding, sanoid/syncoid backup and replication, freshness. Thin over
// lib/storage/service.js (shared with routes/storage.js and the Storage
// page): every mutating tool is the same plan/confirm flow —
//
//   dry_run: true            → { plan, plan_token, commands }   (nothing touched)
//   confirm: true + token    → the service recomputes the plan from the live
//                              host, verifies the sha256 token, runs the steps
//
// The kit wrapper writes the mcp_ledger row; the service writes the
// storage_ops row and the audit entry, so REST and MCP runs land in the same
// ledger. The passphrase argument is redacted from the ledger by
// lib/mcp-ext/logic.js redactArgs (never stored, never logged).

import { deviceEligibility } from '../../lib/storage/planner.js';

export function createStorageHandlers(kit) {
  const { ctx, ok, err, mutation, reader, dry } = kit;
  const svc = () => {
    const s = typeof ctx.storage === 'function' ? ctx.storage() : ctx.storage;
    if (!s) throw new Error('storage service is not configured on this install');
    return s;
  };

  /* ------------------------------- readers ------------------------------ */

  const list_disks = reader('list_disks', async (args) => {
    const inv = await svc().inventory({ smart: args.smart !== false, incus: false });
    return ok({
      count: inv.devices.length, source: inv.source.disks, collected_at: inv.collected_at, warnings: inv.warnings,
      importable_pools: inv.importable,
      devices: inv.devices.map((d) => ({ ...d, eligibility: deviceEligibility(d), eligibility_with_wipe: deviceEligibility(d, { wipe: true }).eligible })),
      note: 'Devices are addressed by their by_id paths. os: true devices are never eligible; wipe: true clears soft signatures on the others.',
    });
  });

  const zpool_status = reader('zpool_status', async () => {
    const p = await svc().host.pools();
    const importable = await svc().host.zpoolImportScan();
    const managed = svc().managed();
    return ok({ count: p.list.length, source: p.source, error: p.error, managed, pools: p.list.map((l) => ({ ...l, status: p.status.find((s) => s.name === l.name) || null })), importable });
  });

  const zfs_list = reader('zfs_list', async (args) => {
    const d = await svc().host.datasets();
    const pool = args.pool ? String(args.pool) : null; const ds = args.dataset ? String(args.dataset) : null;
    const rows = d.datasets.filter((x) => (!pool || x.pool === pool) && (!ds || x.name === ds || x.name.startsWith(`${ds}/`)));
    return ok({ count: rows.length, source: d.source, error: d.error, managed: svc().managed(), datasets: rows });
  });

  const list_zfs_snapshots = reader('list_zfs_snapshots', async (args) => {
    const inv = await svc().inventory({ smart: false });
    let rows = inv.snapshots;
    if (args.guest) { const i = inv.instances.find((x) => x.name === String(args.guest)); if (!i) return err(`guest ${args.guest} not found`); if (!i.dataset) return ok({ count: 0, guest: i.name, snapshots: [], note: `${i.name} is not on a managed ZFS pool (pool ${i.pool || '?'})` }); rows = rows.filter((s) => s.dataset === i.dataset); }
    if (args.dataset) rows = rows.filter((s) => s.dataset === String(args.dataset) || s.dataset.startsWith(`${args.dataset}/`));
    if (args.kind) rows = rows.filter((s) => s.kind === String(args.kind));
    const limit = Math.max(1, Math.min(5000, Number(args.limit) || 500));
    return ok({ count: rows.length, snapshots: rows.slice(-limit), truncated: rows.length > limit });
  });

  const get_backup_policy = reader('get_backup_policy', async () => {
    const inv = await svc().inventory({ smart: false });
    return ok(svc().policyView(inv));
  });

  const replication_status = reader('replication_status', async (args) => {
    const jobs = await svc().replicationStatus();
    const rows = args.name ? jobs.filter((j) => j.name === String(args.name)) : jobs;
    if (args.name && !rows.length) return err(`no replication job named ${args.name}`);
    const f = await svc().freshness({ replication: rows });
    return ok({ count: rows.length, jobs: f.replication, note: 'Only the target string and schedule are stored in ProxyPilot; the SSH key path lives in /etc/proxypilot/storage/replication-<name>.conf on the host.' });
  });

  const storage_freshness = reader('storage_freshness', async (args) => {
    if (args.alerts === true) { const a = await svc().alerts(); return ok({ ...a.freshness, alerts: a.alerts }); }
    return ok(await svc().freshness());
  });

  const storage_preflight = reader('storage_preflight', async (args) => ok(await svc().preflight({ devices: args.devices !== false })));

  const get_storage_install_status = reader('get_storage_install_status', async (args) => ok(await svc().installStatus({ id: args.id ? String(args.id) : null, logTailBytes: Math.min(49152, Number(args.log_tail_bytes) || 8192) })));

  const install_storage_toolchain = mutation('install_storage_toolchain', { subjectType: 'host', flag: 'mcp.storage', audit: 'STORAGE_INSTALL_TOOLCHAIN' }, async (args, auth, req, note) => {
    note.subject_id = 'host';
    if (args.dry_run === true) {
      const pf = await svc().preflight();
      return ok({ dry_run: true, would: { script: pf.script, install_packages: pf.missing_packages, units: ['proxypilot-zfs-scrub@.service', 'proxypilot-zfs-scrub@.timer', 'proxypilot-syncoid@.service', 'proxypilot-syncoid@.timer'], helpers: ['/usr/local/sbin/proxypilot-storage-replicate', '/usr/local/sbin/proxypilot-storage-restore-guest'], enables: ['sanoid.timer'] }, can_install: pf.can_install, install_needed: pf.install_needed, blocked_by: pf.blocked_by, note: 'Nothing was requested. No block device is touched by the installer.' });
    }
    const gate = kit.confirmFlag(args, note, 'This installs zfsutils-linux, smartmontools and sanoid on the HOST, plus the ProxyPilot units and helpers. It touches no disk.');
    if (gate) return gate;
    const r = await svc().installToolchain({ actor: auth?.created_by ?? null, via: 'mcp', force: args.force === true });
    if (r.refused) { note.refused = true; return err(r.error, { preflight: r.preflight }); }
    note.summary = `requested the storage toolchain install (${r.preflight.missing_packages.join(', ') || 're-install'})`;
    note.detail = { id: r.id, missing_packages: r.preflight.missing_packages };
    return ok(r);
  });

  const storage_toolchain = reader('storage_toolchain', async (args) => {
    const tc = await svc().toolchain();
    return ok({ toolchain: tc, agent: svc().host.agentReachable(), managed: svc().managed(), ops: svc().listOps({ limit: Math.max(1, Math.min(500, Number(args.ops_limit) || 50)) }), install: 'scripts/install-storage.sh installs zfsutils-linux, smartmontools, sanoid and the ProxyPilot units.' });
  });

  /* ------------------------------ mutations ----------------------------- */

  const SUBJECT = { create_zpool: 'name', set_managed_pool: 'pool', create_dataset: 'name', set_dataset_props: 'dataset', destroy_dataset: 'dataset', zfs_snapshot: 'dataset', zfs_rollback: 'snapshot', destroy_zfs_snapshot: 'snapshot', replace_disk: 'pool', zpool_scrub: 'pool', import_pool: 'pool', export_pool: 'pool', set_incus_storage_pool: 'name', move_guest_storage: 'pool', set_backup_policy: null, set_replication_target: 'name', run_replication: 'name', restore_guest_from_snapshot: 'new_name', rollback_guest_dataset: 'guest' };

  function planned(op, { subjectType = 'storage', flag = 'mcp.storage', audit = null, prepare = (a) => a } = {}) {
    return mutation(op, { subjectType, flag, audit, keepArgs: ['plan_token', 'dry_run', 'confirm'] }, async (args, auth, req, note) => {
      const params = prepare({ ...args });
      const { dry_run, confirm, plan_token, passphrase, ...rest } = params;
      note.subject_id = SUBJECT[op] ? (rest[SUBJECT[op]] ?? null) : 'policy';
      if (dry_run === true || (confirm !== true && !plan_token)) {
        const p = await svc().plan(op, rest);
        if (p.error) { note.refused = true; return err(p.error); }
        note.subject_id = p.plan.subject;
        note.detail = { plan_token: p.plan_token };
        if (dry_run !== true) { note.needs_confirmation = true; }
        return ok({ dry_run: true, needs_confirmation: true, op, plan: p.plan, plan_token: p.plan_token, commands: p.commands, inventory_at: p.inventory_at, next: `Show the user these commands. On approval re-call ${op} with the same arguments plus confirm: true and plan_token${p.plan.steps.some((s) => s.stdin === 'passphrase') ? ' and the passphrase' : ''}.` });
      }
      if (confirm !== true) { note.refused = true; return err('confirm: true is required together with plan_token'); }
      const r = await svc().apply(op, rest, { plan_token, confirm: true, actor: auth?.created_by ?? null, via: 'mcp', secrets: { passphrase } });
      if (r.refused) { note.refused = true; return err(r.error, r.plan ? { plan: r.plan, plan_token: r.plan_token, commands: r.commands } : null); }
      note.subject_id = r.subject;
      note.confirmation_used = true;
      note.summary = `${r.ok ? 'ran' : 'FAILED'} ${op} on ${r.subject}: ${r.plan.summary}`;
      note.detail = { plan_token: r.plan_token, stamp: r.stamp, ok: r.ok, failed: r.failed || null, steps: r.results.length };
      if (!r.ok) return err(`${op} failed at step ${r.failed.id} (${r.failed.description}): ${r.failed.error}`, { op, subject: r.subject, results: r.results, plan: r.plan, reversal: r.plan.reversal });
      return ok({ applied: true, op, subject: r.subject, summary: r.plan.summary, stamp: r.stamp, results: r.results, reversal: r.plan.reversal, ...(r.plan.existing_pools ? { existing_pools: r.plan.existing_pools } : {}), ...(r.plan.stream_file ? { stream_file: r.plan.stream_file.replaceAll('{{stamp}}', r.stamp) } : {}) });
    });
  }

  const handlers = {
    list_disks, zpool_status, zfs_list, list_zfs_snapshots, get_backup_policy, replication_status, storage_freshness, storage_toolchain,
    storage_preflight, install_storage_toolchain, get_storage_install_status,
    create_zpool: planned('create_zpool', { subjectType: 'zpool' }),
    set_managed_pool: planned('set_managed_pool', { subjectType: 'zpool' }),
    create_dataset: planned('create_dataset', { subjectType: 'zfs' }),
    set_dataset_props: planned('set_dataset_props', { subjectType: 'zfs' }),
    destroy_dataset: planned('destroy_dataset', { subjectType: 'zfs', flag: 'mcp.destructive' }),
    zfs_snapshot: planned('zfs_snapshot', { subjectType: 'zfs' }),
    zfs_rollback: planned('zfs_rollback', { subjectType: 'zfs', flag: 'mcp.destructive' }),
    destroy_zfs_snapshot: planned('destroy_zfs_snapshot', { subjectType: 'zfs', flag: 'mcp.destructive' }),
    replace_disk: planned('replace_disk', { subjectType: 'zpool' }),
    zpool_scrub: planned('zpool_scrub', { subjectType: 'zpool' }),
    import_pool: planned('import_pool', { subjectType: 'zpool' }),
    export_pool: planned('export_pool', { subjectType: 'zpool' }),
    set_incus_storage_pool: planned('set_incus_storage_pool', { subjectType: 'incus-storage', prepare: (a) => ({ ...a, name: a.name || 'zfs', dataset: a.dataset || svc().managed()?.datasets?.incus || null }) }),
    move_guest_storage: planned('move_guest_storage', { subjectType: 'lxc' }),
    set_backup_policy: planned('set_backup_policy', { subjectType: 'storage-policy' }),
    set_replication_target: planned('set_replication_target', { subjectType: 'replication' }),
    run_replication: planned('run_replication', { subjectType: 'replication' }),
    restore_guest_from_snapshot: planned('restore_guest_from_snapshot', { subjectType: 'lxc' }),
    rollback_guest_dataset: planned('rollback_guest_dataset', { subjectType: 'lxc', flag: 'mcp.destructive' }),
  };
  return handlers;
}
