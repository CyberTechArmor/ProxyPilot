// ZFS storage management — the service the REST router and the MCP tools
// share. One inventory, one plan/confirm flow, one executor, one ledger.
//
//   inventory()                  everything the planner and the page need, in one pass
//   plan(op, params)             { plan, plan_token, commands } or { error }   — dry run
//   apply(op, params, opts)      recomputes the plan, checks the token, runs the steps,
//                                records a storage_ops row (migration 908) and an audit entry
//   policy / replication         stored in app_settings (storage.*), rendered onto the host by plans
//   freshness() / alerts()       lib/storage/freshness.js over the live inventory
//
// Settings (app_settings):
//   storage.managed        { pool, incus_pool, datasets: { incus, backups, exports } }
//   storage.backup_policy  the policy document (lib/storage/policy.js)
//   storage.replication    { <name>: { name, sources, target, kind, schedule, recursive, enabled } }  — never the key path

import {
  planCreateZpool, planCreateDataset, planSetDatasetProps, planDestroyDataset, planSnapshot, planRollback, planDestroySnapshot,
  planReplaceDisk, planScrub, planImportPool, planExportPool, planSetIncusStoragePool, planMoveGuestStorage,
  planRestoreGuestFromSnapshot, planRollbackGuestDataset, planWriteHostFile, planToken, verifyPlanToken, renderPlanCommands,
  validPoolName, validDataset, MANAGED_DATASETS, INCUS_NAME_RE, REPLICATION_NAME_RE,
} from './planner.js';
import { resolvePolicy, applyPolicyUpdate, renderSanoidConf, validateReplication, renderReplicationConf, renderTimerDropIn, effectiveRetention } from './policy.js';
import { computeFreshness, storageAlerts } from './freshness.js';
import { installPreflight } from './preflight.js';
import { incusInstanceDataset } from './parse.js';
import { REPLICATION_CONF_DIR, REPLICATION_STATE_DIR, SANOID_CONF, REPLICATE_BIN, RESTORE_HELPER } from './host.js';

const SETTING_MANAGED = 'storage.managed';
const SETTING_POLICY = 'storage.backup_policy';
const SETTING_REPLICATION = 'storage.replication';

function stampNow(d = new Date()) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function tail(s, n = 2000) { return String(s || '').trim().slice(-n); }
function jsonSetting(getSetting, key, fallback) {
  try { const v = getSetting(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export function createStorageService({ host, getDb = null, getSetting, setSetting, logAudit = () => {}, now = () => Date.now() } = {}) {
  if (!host) throw new Error('createStorageService needs a host');

  /* ------------------------------- settings ------------------------------ */

  const managed = () => {
    const m = jsonSetting(getSetting, SETTING_MANAGED, null);
    if (!m || !m.pool) return null;
    return { pool: m.pool, incus_pool: m.incus_pool || null, datasets: { incus: m.datasets?.incus || `${m.pool}/${MANAGED_DATASETS.incus}`, backups: m.datasets?.backups || `${m.pool}/${MANAGED_DATASETS.backups}`, exports: m.datasets?.exports || `${m.pool}/${MANAGED_DATASETS.exports}` } };
  };
  const storedPolicy = () => jsonSetting(getSetting, SETTING_POLICY, {});
  // Has an operator actually applied a backup policy? (An empty setting means
  // no: freshness must not report snapshots as overdue that nobody asked for.)
  const policyApplied = () => { try { return !!getSetting(SETTING_POLICY); } catch { return false; } };
  const storedReplication = () => jsonSetting(getSetting, SETTING_REPLICATION, {});

  /* ------------------------------ inventory ------------------------------ */

  async function inventory({ smart = true, incus = true } = {}) {
    const warnings = [];
    const p = await host.pools();
    if (p.error) warnings.push(`zpool list: ${p.error}`);
    const [disks, ds] = await Promise.all([host.listDisks({ smart, poolStatus: p.status }), host.datasets()]);
    // The safety facts lsblk cannot see. Attached to each device so
    // deviceEligibility refuses an fstab-referenced or RAID-member disk.
    let safety = { risks: {}, facts: null };
    try { safety = await host.risksFor(disks.devices); } catch (e) { warnings.push(`device safety checks failed: ${e?.message || e}`); }
    for (const d of disks.devices) d.risk = safety.risks[d.name] || { hard: [], warnings: [] };
    if (ds.error) warnings.push(`zfs list: ${ds.error}`);
    for (const w of disks.warnings || []) warnings.push(w);
    let incusPools = []; let instances = []; let defaultProfileRoot = null; let incusSnapshotForm = 'sub';
    if (incus) {
      [incusPools, instances, defaultProfileRoot, incusSnapshotForm] = await Promise.all([host.incusStoragePools(), host.incusInstances(), host.incusDefaultProfileRoot(), host.incusSnapshotForm()]);
    }
    const zfsPools = incusPools.filter((x) => x.driver === 'zfs' && x.source);
    for (const i of instances) {
      const ip = zfsPools.find((x) => x.name === i.pool);
      i.dataset = ip ? incusInstanceDataset(ip.source, i) : null;
      if (i.dataset && !ds.datasets.some((d) => d.name === i.dataset)) i.dataset = null;
    }
    const m = managed();
    const mountOf = (name) => ds.datasets.find((d) => d.name === name)?.mountpoint || null;
    return {
      collected_at: new Date(now()).toISOString(), source: { disks: disks.source, pools: p.source, datasets: ds.source },
      devices: disks.devices, importable: disks.importable, pools: p.list, poolStatus: p.status, datasets: ds.datasets, snapshots: ds.snapshots,
      incusPools, instances, defaultProfileRoot, incusSnapshotForm, incusSources: zfsPools.map((x) => x.source),
      safety: safety.facts,
      managed: m ? { ...m, mountpoints: { backups: mountOf(m.datasets.backups), exports: mountOf(m.datasets.exports), incus: mountOf(m.datasets.incus) }, present: ds.datasets.some((d) => d.name === m.pool) } : null,
      backupsDir: m ? (mountOf(m.datasets.backups) && mountOf(m.datasets.backups) !== 'none' && mountOf(m.datasets.backups) !== 'legacy' ? mountOf(m.datasets.backups) : null) : null,
      restoreHelper: RESTORE_HELPER, warnings,
    };
  }

  /* --------------------------------- plans ------------------------------- */

  function planSetManagedPool(inv, params) {
    const pool = validPoolName(params.pool);
    if (!pool || !inv.pools.some((p) => p.name === pool)) return { error: `pool ${params.pool || '(none)'} is not imported` };
    const incusPool = params.incus_pool != null ? String(params.incus_pool) : (inv.incusPools.find((p) => p.driver === 'zfs' && p.source && p.source.split('/')[0] === pool)?.name || null);
    if (incusPool && !INCUS_NAME_RE.test(incusPool)) return { error: 'incus_pool: invalid name' };
    const datasets = { incus: params.datasets?.incus || `${pool}/${MANAGED_DATASETS.incus}`, backups: params.datasets?.backups || `${pool}/${MANAGED_DATASETS.backups}`, exports: params.datasets?.exports || `${pool}/${MANAGED_DATASETS.exports}` };
    for (const [k, v] of Object.entries(datasets)) { if (!validDataset(v) || v.split('/')[0] !== pool) return { error: `datasets.${k} must live in ${pool}` }; }
    const plan = { op: 'set_managed_pool', subject: pool, summary: `Manage pool ${pool} (Incus: ${datasets.incus}, backups: ${datasets.backups}, exports: ${datasets.exports}${incusPool ? `, Incus storage pool ${incusPool}` : ''})`, steps: [], warnings: [], reversal: 'the setting is cleared by set_managed_pool with pool: null', touches: [], managed: { pool, incus_pool: incusPool, datasets } };
    let n = 0;
    for (const [k, v] of Object.entries(datasets)) if (!inv.datasets.some((d) => d.name === v)) plan.steps.push({ id: `s${++n}`, argv: ['zfs', 'create', '-p', v], description: `Create the missing ${k} dataset ${v}`, stdin: null, timeout_ms: 60000, ignore_failure: false, kind: 'exec' });
    if (!plan.steps.length) plan.steps.push({ id: 's1', argv: ['zfs', 'list', '-H', '-o', 'name', pool], description: 'Verify the pool is present', stdin: null, timeout_ms: 30000, ignore_failure: false, kind: 'verify' });
    return { plan };
  }

  function planBackupPolicy(inv, params) {
    let next;
    try { next = applyPolicyUpdate(storedPolicy(), params.update || params); } catch (e) { return { error: e.message }; }
    const m = inv.managed;
    if (!m) return { error: 'no managed pool yet — create_zpool (managed) or set_managed_pool first' };
    const guestDatasets = inv.instances.filter((i) => i.dataset).map((i) => ({ guest: i.name, dataset: i.dataset }));
    const content = renderSanoidConf({ policy: next, managed: m.datasets, guestDatasets });
    const plan = planWriteHostFile('set_backup_policy', 'sanoid', `Update the backup policy and rewrite ${SANOID_CONF}`, {
      path: SANOID_CONF, content, after: [{ argv: ['systemctl', 'enable', '--now', 'sanoid.timer'], description: 'Make sure sanoid.timer runs (every 15 minutes) — reported, not fatal, so the policy file still lands where sanoid is not installed yet', extra: { timeout_ms: 30000, ignore_failure: true } }],
    });
    plan.policy = next;
    plan.reversal = 'set_backup_policy with the previous values (get_backup_policy shows them)';
    return { plan };
  }

  function planReplication(inv, params) {
    if (params.remove === true) {
      const name = String(params.name || '');
      if (!REPLICATION_NAME_RE.test(name) || !storedReplication()[name]) return { error: `no replication job named ${name || '(none)'}` };
      const unit = `proxypilot-syncoid@${name}.timer`;
      const plan = { op: 'set_replication_target', subject: name, summary: `Remove replication job ${name}`, steps: [
        { id: 's1', argv: ['systemctl', 'disable', '--now', unit], description: `Disable ${unit}`, stdin: null, timeout_ms: 30000, ignore_failure: true, kind: 'exec' },
        { id: 's2', argv: ['rm', '-f', `${REPLICATION_CONF_DIR}/replication-${name}.conf`, `/etc/systemd/system/${unit}.d/schedule.conf`], description: 'Remove its configuration', stdin: null, timeout_ms: 30000, ignore_failure: false, kind: 'exec' },
        { id: 's3', argv: ['systemctl', 'daemon-reload'], description: 'Reload systemd', stdin: null, timeout_ms: 60000, ignore_failure: false, kind: 'exec' },
      ], warnings: [], reversal: 'set_replication_target again', touches: [], remove: name };
      return { plan };
    }
    const v = validateReplication(params);
    if (v.error) return v;
    const cfg = v.config;
    for (const s of cfg.sources) if (!inv.datasets.some((d) => d.name === s)) return { error: `source dataset ${s} does not exist` };
    if (cfg.kind === 'local' && !inv.pools.some((p) => p.name === cfg.target.split('/')[0])) return { error: `target pool ${cfg.target.split('/')[0]} is not imported` };
    if (cfg.kind === 'local' && cfg.sources.some((s) => cfg.target === s || cfg.target.startsWith(`${s}/`) || s.startsWith(`${cfg.target}/`))) return { error: 'target must not be inside a source dataset (or the other way round)' };
    const unit = `proxypilot-syncoid@${cfg.name}.timer`;
    const plan = planWriteHostFile('set_replication_target', cfg.name, `${storedReplication()[cfg.name] ? 'Update' : 'Create'} replication job ${cfg.name}: ${cfg.sources.join(', ')} → ${cfg.target} (${cfg.kind}, ${cfg.schedule})`, {
      path: `${REPLICATION_CONF_DIR}/replication-${cfg.name}.conf`, content: renderReplicationConf(cfg), mode: '0600',
    });
    plan.steps.push({ id: 's2', argv: ['sh', '-c', 'umask 022 && mkdir -p "$1" && cat > "$1/schedule.conf"', 'sh', `/etc/systemd/system/${unit}.d`], description: `Write the schedule drop-in for ${unit}`, stdin: 'content', content: renderTimerDropIn(cfg.schedule), timeout_ms: 30000, ignore_failure: false, kind: 'exec' });
    plan.steps.push({ id: 's3', argv: ['systemctl', 'daemon-reload'], description: 'Reload systemd', stdin: null, timeout_ms: 60000, ignore_failure: false, kind: 'exec' });
    plan.steps.push({ id: 's4', argv: ['systemctl', cfg.enabled ? 'enable' : 'disable', '--now', unit], description: `${cfg.enabled ? 'Enable' : 'Disable'} ${unit}`, stdin: null, timeout_ms: 30000, ignore_failure: false, kind: 'exec' });
    if (cfg.kind === 'remote') plan.warnings.push(`The SSH key at ${cfg.ssh_key_path} must exist on the host and be authorized on ${cfg.target.split(':')[0]}; run_replication reports the first failure.`);
    plan.replication = { name: cfg.name, sources: cfg.sources, target: cfg.target, kind: cfg.kind, schedule: cfg.schedule, recursive: cfg.recursive, enabled: cfg.enabled };
    plan.reversal = `set_replication_target { name: "${cfg.name}", remove: true }`;
    return { plan };
  }

  function planRunReplication(inv, params) {
    const name = String(params.name || '');
    const cfg = storedReplication()[name];
    if (!REPLICATION_NAME_RE.test(name) || !cfg) return { error: `no replication job named ${name || '(none)'} (replication_status lists them)` };
    const wait = params.wait !== false;
    const plan = { op: 'run_replication', subject: name, summary: `Run replication ${name} now (${cfg.sources.join(', ')} → ${cfg.target})${wait ? '' : ', in the background'}`, steps: [], warnings: [], reversal: 'none — replication is additive on the target', touches: [] };
    plan.steps.push(wait
      ? { id: 's1', argv: [REPLICATE_BIN, name], description: 'Run syncoid through the ProxyPilot wrapper (writes the status file)', stdin: null, timeout_ms: 12 * 3600 * 1000, ignore_failure: false, kind: 'exec' }
      : { id: 's1', argv: ['systemctl', 'start', '--no-block', `proxypilot-syncoid@${name}.service`], description: 'Start the replication unit in the background', stdin: null, timeout_ms: 30000, ignore_failure: false, kind: 'exec' });
    return { plan };
  }

  const PLANNERS = {
    create_zpool: planCreateZpool, create_dataset: planCreateDataset, set_dataset_props: planSetDatasetProps, destroy_dataset: planDestroyDataset,
    zfs_snapshot: planSnapshot, zfs_rollback: planRollback, destroy_zfs_snapshot: planDestroySnapshot, replace_disk: planReplaceDisk, zpool_scrub: planScrub,
    import_pool: planImportPool, export_pool: planExportPool, set_incus_storage_pool: planSetIncusStoragePool, move_guest_storage: planMoveGuestStorage,
    restore_guest_from_snapshot: planRestoreGuestFromSnapshot, rollback_guest_dataset: planRollbackGuestDataset,
    set_managed_pool: planSetManagedPool, set_backup_policy: planBackupPolicy, set_replication_target: planReplication, run_replication: planRunReplication,
  };
  const OP_NAMES = Object.freeze(Object.keys(PLANNERS));

  /**
   * Binaries an op's plan will actually invoke. Checked BEFORE the plan is
   * handed out, because a plan whose first step is destructive and whose
   * second step needs a missing binary is the worst possible outcome:
   * `create_zpool` would wipefs the disk and then fail on `zpool create`,
   * leaving it blank with no pool. A missing tool is a refusal, never a
   * half-run plan.
   */
  const OP_BINARIES = {
    create_zpool: ['zpool', 'zfs', 'wipefs'], set_managed_pool: ['zfs'], create_dataset: ['zfs'], set_dataset_props: ['zfs'],
    destroy_dataset: ['zfs'], zfs_snapshot: ['zfs'], zfs_rollback: ['zfs'], destroy_zfs_snapshot: ['zfs'],
    replace_disk: ['zpool'], zpool_scrub: ['zpool'], import_pool: ['zpool'], export_pool: ['zpool'],
    set_incus_storage_pool: ['zfs', 'incus'], move_guest_storage: ['incus'],
    restore_guest_from_snapshot: ['incus'], rollback_guest_dataset: ['zfs', 'incus'], set_backup_policy: ['zfs'],
  };
  const INSTALL_HINT = 'run `sudo bash scripts/install-storage.sh` on the host first — it installs zfsutils-linux, smartmontools and sanoid plus the ProxyPilot units and helpers';

  async function missingBinary(op) {
    for (const bin of OP_BINARIES[op] || []) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await host.hasBinary(bin))) return bin;
    }
    return null;
  }

  async function plan(op, params = {}, { inv = null } = {}) {
    const fn = PLANNERS[op];
    if (!fn) return { error: `unknown storage operation ${op}` };
    const missing = await missingBinary(op);
    if (missing) return { error: `${missing} is not installed on this host, so ${op} cannot run: ${INSTALL_HINT}. Nothing was touched.` };
    const inventoryNow = inv || await inventory({ smart: ['create_zpool', 'replace_disk'].includes(op) });
    const r = fn(inventoryNow, params || {});
    if (r.error) return { error: r.error, inventory_at: inventoryNow.collected_at };
    const token = planToken(r.plan);
    return { plan: r.plan, plan_token: token, commands: renderPlanCommands(r.plan), inventory_at: inventoryNow.collected_at };
  }

  /* -------------------------------- apply -------------------------------- */

  function recordOp(row) {
    if (!getDb) return;
    try {
      getDb().prepare(`INSERT INTO storage_ops (ts, actor, via, op, subject, plan_token, plan_json, outcome, detail_json, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.ts, row.actor ?? null, row.via ?? null, row.op, row.subject ?? null, row.plan_token ?? null, JSON.stringify(row.plan ?? null), row.outcome, JSON.stringify(row.detail ?? {}), row.duration_ms ?? null);
    } catch (e) { console.warn('[storage] ops ledger write failed:', e?.message || e); }
  }

  function listOps({ limit = 50, op = null } = {}) {
    if (!getDb) return [];
    try {
      const rows = op ? getDb().prepare('SELECT * FROM storage_ops WHERE op = ? ORDER BY id DESC LIMIT ?').all(op, limit) : getDb().prepare('SELECT * FROM storage_ops ORDER BY id DESC LIMIT ?').all(limit);
      return rows.map((r) => ({ ...r, plan: safeJson(r.plan_json), detail: safeJson(r.detail_json), plan_json: undefined, detail_json: undefined }));
    } catch { return []; }
  }
  function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

  function verifyStep(stepDef, r) {
    if (stepDef.expect === 'Running') {
      try { const j = JSON.parse(r.stdout); return Array.isArray(j) && j.length > 0 && j.every((i) => i.status === 'Running') ? null : `guest is not running (${(j[0] || {}).status || 'not found'})`; } catch { return 'could not parse incus list output'; }
    }
    return null;
  }

  /**
   * apply(op, params, { plan_token, confirm, actor, via, ip, secrets })
   * Recomputes the plan from the live inventory, verifies the token, runs the steps.
   */
  async function apply(op, params = {}, { plan_token = null, confirm = false, actor = null, via = 'api', ip = null, secrets = {} } = {}) {
    const t0 = now();
    if (confirm !== true) return { error: 'confirm: true is required (after the operator approved the plan)', refused: true };
    const p = await plan(op, params);
    if (p.error) { recordOp({ ts: new Date(t0).toISOString(), actor, via, op, subject: params?.name || params?.pool || params?.dataset || null, plan_token, plan: null, outcome: 'refused', detail: { error: p.error }, duration_ms: now() - t0 }); return { error: p.error, refused: true }; }
    const v = verifyPlanToken(p.plan, plan_token);
    if (!v.ok) { recordOp({ ts: new Date(t0).toISOString(), actor, via, op, subject: p.plan.subject, plan_token, plan: p.plan, outcome: 'refused', detail: { error: v.error, expected_token: v.token }, duration_ms: now() - t0 }); return { error: v.error, refused: true, plan: p.plan, plan_token: v.token, commands: p.commands }; }
    const stamp = stampNow(new Date(now()));
    const results = [];
    let failed = null;
    for (const s of p.plan.steps) {
      const argv = s.argv.map((a) => String(a).replaceAll('{{stamp}}', stamp));
      let input = null;
      if (s.stdin === 'passphrase') {
        if (typeof secrets.passphrase !== 'string' || secrets.passphrase.length < 8) { failed = { id: s.id, error: 'this plan needs a passphrase of at least 8 characters (pass it as `passphrase`; it is never stored or logged)' }; break; }
        input = `${secrets.passphrase}\n`;
      } else if (s.stdin === 'content') input = s.content;
      const st = now();
      const r = await host.exec(argv, { timeoutMs: s.timeout_ms || 120000, input });
      const rec = { id: s.id, description: s.description, argv, status: r.status, timed_out: r.timedOut, stdout: tail(r.stdout), stderr: tail(r.stderr), ms: now() - st };
      const bad = r.status !== 0 ? (r.timedOut ? 'timed out' : `exit ${r.status}: ${tail(r.stderr, 400) || tail(r.stdout, 400) || r.error || 'no output'}`) : verifyStep(s, r);
      rec.ok = !bad;
      results.push(rec);
      if (bad && !s.ignore_failure) { failed = { id: s.id, description: s.description, error: bad }; break; }
    }
    const outcome = failed ? 'failed' : 'ok';
    const detail = { stamp, steps: results.map((r) => ({ id: r.id, ok: r.ok, status: r.status, ms: r.ms })), failed };
    recordOp({ ts: new Date(t0).toISOString(), actor, via, op, subject: p.plan.subject, plan_token: v.token, plan: p.plan, outcome, detail, duration_ms: now() - t0 });
    try { logAudit(actor, `STORAGE_${op.toUpperCase()}`, 'storage', p.plan.subject, { via, outcome, plan_token: v.token, stamp, ...(failed ? { failed } : {}) }, ip); } catch { /* best effort */ }
    if (!failed) await afterApply(op, p.plan, params);
    return { ok: !failed, op, subject: p.plan.subject, plan: p.plan, plan_token: v.token, commands: p.commands, stamp, results, failed, duration_ms: now() - t0 };
  }

  async function afterApply(op, plan, params) {
    if (op === 'create_zpool' && plan.managed_datasets) setSetting(SETTING_MANAGED, JSON.stringify({ pool: plan.subject, incus_pool: managed()?.incus_pool && managed()?.pool === plan.subject ? managed().incus_pool : null, datasets: plan.managed_datasets }));
    if (op === 'set_managed_pool') setSetting(SETTING_MANAGED, params.pool == null ? '' : JSON.stringify(plan.managed));
    if (op === 'set_incus_storage_pool') {
      const m = managed();
      const pool = String(params.dataset).split('/')[0];
      if (m && m.pool === pool) setSetting(SETTING_MANAGED, JSON.stringify({ ...m, incus_pool: plan.subject }));
      else if (!m) setSetting(SETTING_MANAGED, JSON.stringify({ pool, incus_pool: plan.subject, datasets: { incus: String(params.dataset), backups: `${pool}/${MANAGED_DATASETS.backups}`, exports: `${pool}/${MANAGED_DATASETS.exports}` } }));
    }
    if (op === 'export_pool') { const m = managed(); if (m && m.pool === plan.subject) setSetting(SETTING_MANAGED, ''); }
    if (op === 'set_backup_policy' && plan.policy) setSetting(SETTING_POLICY, JSON.stringify(plan.policy));
    if (op === 'set_replication_target') {
      const all = storedReplication();
      if (plan.remove) delete all[plan.remove]; else all[plan.replication.name] = plan.replication;
      setSetting(SETTING_REPLICATION, JSON.stringify(all));
    }
  }

  /* ------------------------ policy / replication views ------------------- */

  function policyView(inv) {
    const p = resolvePolicy(storedPolicy());
    const m = inv?.managed || managed();
    const datasets = (inv?.datasets || []).filter((d) => d.type !== 'snapshot').map((d) => {
      const guest = (inv?.instances || []).find((i) => i.dataset === d.name);
      return { dataset: d.name, guest: guest?.name || null, ...effectiveRetention(d.name, { managed: m?.datasets || null, policy: p, guest: guest?.name || null }) };
    });
    return { policy: p, managed: m, datasets, sanoid_conf: SANOID_CONF, rendered: m ? renderSanoidConf({ policy: p, managed: m.datasets, guestDatasets: (inv?.instances || []).filter((i) => i.dataset).map((i) => ({ guest: i.name, dataset: i.dataset })) }) : null };
  }

  async function replicationStatus() {
    const all = storedReplication();
    const jobs = [];
    for (const cfg of Object.values(all)) {
      const raw = await host.readFile(`${REPLICATION_STATE_DIR}/replication/${cfg.name}.json`);
      let state = null; try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
      const timer = await host.unitState(`proxypilot-syncoid@${cfg.name}.timer`);
      jobs.push({
        ...cfg, last_run_at: state?.started_at || null, last_finished_at: state?.finished_at || null, last_success_at: state?.last_success_at || (state?.ok ? state?.finished_at : null) || null,
        last_error: state?.ok === false ? (state?.error || 'failed') : null, last_exit_code: state?.exit_code ?? null, log_tail: state?.log_tail || null, running: state?.running === true,
        timer: { active: timer.ActiveState || null, enabled: timer.UnitFileState || null, next_run: timer.NextElapseUSecRealtime || null, last_trigger: timer.LastTriggerUSec || null, present: timer.present },
      });
    }
    return jobs;
  }

  /** What the host can actually deliver in the way of snapshots, for freshness. */
  async function backupPosture() {
    const applied = policyApplied();
    let tc = null;
    try { tc = await host.toolchain(); } catch { tc = null; }
    const timer = tc?.sanoid_timer || null;
    return {
      pool: managed()?.pool || null, policy_applied: applied,
      sanoid_installed: tc ? !!tc.sanoid : true,
      timer_present: timer ? !!timer.present : true,
      timer_state: timer?.ActiveState || null, timer_enabled: timer?.UnitFileState || null,
    };
  }

  async function freshness({ inv = null, replication = null } = {}) {
    const inventoryNow = inv || await inventory({ smart: false });
    const jobs = replication || await replicationStatus();
    const backup = await backupPosture();
    const f = computeFreshness({ pools: inventoryNow.pools, poolStatus: inventoryNow.poolStatus, datasets: inventoryNow.datasets, snapshots: inventoryNow.snapshots, instances: inventoryNow.instances, managed: inventoryNow.managed?.datasets || null, policy: resolvePolicy(storedPolicy()), replication: jobs, backup, now: now() });
    return { ...f, managed: inventoryNow.managed, warnings: inventoryNow.warnings };
  }

  async function alerts({ inv = null } = {}) {
    const inventoryNow = inv || await inventory({ smart: true });
    const f = await freshness({ inv: inventoryNow });
    return { freshness: f, alerts: storageAlerts(f, inventoryNow.devices), devices: inventoryNow.devices };
  }

  /* ------------------------- preflight and install ------------------------ */

  /**
   * Can this host install and run the storage stack, and what is already in
   * place? Read-only. `devices: true` also returns the per-device safety
   * verdict, so the page can show why a disk is or is not takeable without a
   * second round trip.
   */
  async function preflight({ devices = false } = {}) {
    const [toolchain, os, runner, agent] = await Promise.all([host.toolchain(), host.osRelease(), host.runnerState(), host.agentPing()]);
    const apt = await host.hasBinary('apt-get');
    // Only ask apt when apt exists; undefined means "not looked up".
    const zfsCandidate = apt ? await host.aptCandidate('zfsutils-linux') : undefined;
    const kernel = await host.kernelState();
    const report = installPreflight({ toolchain, os, runner, agent, apt, zfsCandidate, kernel });
    const out = { at: new Date(now()).toISOString(), ...report, toolchain, os, runner, agent, managed: managed() };
    if (devices) {
      const inv = await inventory({ smart: false, incus: false });
      const { deviceEligibility } = await import('./planner.js');
      out.devices = inv.devices.map((d) => ({
        name: d.name, path: d.path, model: d.model, serial: d.serial, size_bytes: d.size_bytes, os: d.os, os_reason: d.os_reason,
        by_id: d.by_id, risk: d.risk, eligibility: deviceEligibility(d), eligibility_with_wipe: deviceEligibility(d, { wipe: true }).eligible,
      }));
      out.safety_checked = inv.safety || null;
    }
    return out;
  }

  /**
   * Request the install. Refuses when the preflight is blocked, so the caller
   * never waits on a runner that cannot succeed. Returns the run id; progress
   * is the ordinary self-update status, since one runner serves both.
   */
  async function installToolchain({ actor = null, via = 'api', ip = null, force = false } = {}) {
    const pf = await preflight();
    if (!pf.can_install) return { refused: true, error: `preflight is blocked: ${pf.blocked_by.map((b) => b.detail).join('; ')}`, preflight: pf };
    if (pf.reboot_required && !force) return { refused: true, reboot_required: true, error: `everything is installed and a ZFS module is built for ${pf.kernel?.built_for?.join(', ') || 'another kernel'}, but this host is running ${pf.kernel?.running}. A module only loads into the kernel it was built for: reboot into ${pf.kernel?.reboot_target} and it loads. Re-running the installer changes nothing; pass force: true to run it anyway.`, preflight: pf };
    if (!pf.install_needed && !force) return { refused: true, already_installed: true, error: 'the storage toolchain is already installed and current; pass force: true to run the installer again', preflight: pf };
    const { startStorageInstall } = await import('../self-update.js');
    let started;
    try {
      started = await startStorageInstall({ requestedBy: `${via}:${actor || 'unknown'}` });
    } catch (e) {
      return { refused: true, error: `${e.code || 'error'}: ${e.message}`, preflight: pf };
    }
    recordOp({ ts: new Date(now()).toISOString(), actor, via, op: 'install_storage_toolchain', subject: 'host', plan_token: null, plan: null, outcome: 'ok', detail: { id: started.id, missing_packages: pf.missing_packages, reinstall_only: pf.reinstall_only }, duration_ms: null });
    try { logAudit(actor, 'STORAGE_INSTALL_TOOLCHAIN', 'storage', 'host', { via, id: started.id, missing_packages: pf.missing_packages }, ip); } catch { /* best effort */ }
    return { started: true, id: started.id, requested_at: started.requested_at, preflight: pf, next: 'poll the install status; the host installs packages and units, which takes a minute or two. Nothing touches a block device.' };
  }

  /**
   * Progress of an install run. The runner writes one state file per action,
   * so this is the self-update state — but its phase LIST and 7-phase total
   * describe update.sh, not an install, so they are dropped rather than shown
   * as a meaningless "3 of 7". An id whose state has not appeared yet is
   * reported as queued while the request is still sitting in the run
   * directory, so a run waiting on the path unit is not mistaken for a lost
   * one and left to time out.
   */
  async function installStatus({ id = null, logTailBytes = 8192 } = {}) {
    const { updateStatus } = await import('../self-update.js');
    const st = await updateStatus({ id: id || undefined, logTailBytes });
    const mine = !id || st.id === id;
    const isInstall = st.action === 'storage-install';
    if (id && !mine) {
      let pending = false;
      try { pending = (await host.readFile('/run/proxypilot-update/request.json', { maxBytes: 4096 })) != null; } catch { pending = false; }
      return {
        id, action: 'storage-install', is_storage_install: true,
        status: pending ? 'queued' : 'unknown',
        phase: pending ? 'Waiting for the host runner to pick the request up' : 'No state was recorded for this run',
        phase_index: null, phase_total: null, phases: [], terminal: !pending, exit_code: null,
        reason: pending ? null : 'the runner never recorded this id; check the host journal for proxypilot-update.service',
        log_tail: '', started_at: null, finished_at: null,
      };
    }
    return { ...st, is_storage_install: isInstall, ...(isInstall ? { phases: [], phase_index: null, phase_total: null } : {}) };
  }

  /** The block export_grc_evidence embeds. */
  async function evidence() {
    try {
      const inv = await inventory({ smart: true });
      const f = await freshness({ inv });
      return {
        managed: inv.managed, pools: f.pools, guests: f.guests, replication: f.replication.map((r) => ({ name: r.name, target: r.target, schedule: r.schedule, status: r.status, last_success_at: r.last_success_at })),
        devices: inv.devices.map((d) => ({ path: d.path, model: d.model, serial: d.serial, size_bytes: d.size_bytes, os: d.os, in_pool: d.in_pool, smart: d.smart_verdict })),
        policy: resolvePolicy(storedPolicy()), recent_ops: listOps({ limit: 100 }).map((o) => ({ ts: o.ts, actor: o.actor, via: o.via, op: o.op, subject: o.subject, outcome: o.outcome, plan_token: o.plan_token })),
      };
    } catch (e) { return { error: e?.message || String(e) }; }
  }

  return { inventory, plan, apply, listOps, managed, policyView, storedPolicy, replicationStatus, freshness, alerts, evidence, preflight, installToolchain, installStatus, OP_NAMES, toolchain: () => host.toolchain(), host };
}
