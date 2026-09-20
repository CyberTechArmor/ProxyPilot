// LXC administration over MCP — the verbs the first LXC surface deliberately
// left out (delete, clone, export/import, snapshot restore/delete, devices,
// resources, in-guest file ops, service control, packages, per-guest
// allowlists, egress, port forwards, cron), now with the guards that make
// them safe to expose: a snapshot or export BEFORE anything destructive, a
// one-time confirmation token on delete/restore, dry_run everywhere, and the
// ledger row written by the server.

import { reconcileServiceL4Forwards } from '../../lib/l4-reconciler.js';
import {
  intIn, validOctalMode, UNIT_NAME_RE, APT_PACKAGE_RE, CRON_LINE_RE, stamp, pathUnder, LXC_NAME_RE, sha256Hex,
} from '../../lib/mcp-ext/logic.js';

const PROXYPILOT_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';

import { exportStore } from '../../lib/lxc-exports-instance.js';
import { COMPRESSION_SETTING, resolveCompression, incusCompressionArgs } from '../../lib/export-compression.js';

export function createLxcAdminHandlers(kit) {
  const { ctx, ok, err, mutation, reader, confirmToken, confirmFlag, dry, guestSh, hostSh, tail, policy } = kit;
  const {
    getDb, runHostCapture, LXC_PREFIX, LXC_NAME_REGEX, validLxcFilePath, validTargetDir,
    takeLxcSnapshot, fetchLxcInstance, lxcContainerDetail, defaultSnapshotName, validSnapshotName,
    snapshotArgv, resolveSnapshotCliForm, takeUploadTicket, findOrCreateLxcService, regenerateDomainCaddyConfig,
    caddyReload, LXC_LIST_CAPTURE_CAP,
  } = ctx;
  // Export tarballs go to the managed ZFS exports dataset when one is mounted
  // (Storage page / create_zpool), else the policy directory.
  const EXPORTS_DEFAULT = policy.exports_dir;
  let EXPORTS = EXPORTS_DEFAULT;
  async function exportsDir() {
    try {
      const svc = typeof ctx.storage === 'function' ? ctx.storage() : ctx.storage;
      const m = svc?.managed();
      if (m) {
        const d = await svc.host.datasets();
        const mp = d.datasets.find((x) => x.name === m.datasets.exports)?.mountpoint;
        EXPORTS = mp && mp.startsWith('/') ? mp : EXPORTS_DEFAULT;
        return EXPORTS;
      }
    } catch { /* fall back */ }
    EXPORTS = EXPORTS_DEFAULT;
    return EXPORTS;
  }

  const nameOf = (args) => {
    const name = String(args.container || '');
    return LXC_NAME_REGEX.test(name) ? name : null;
  };
  const incus = (name) => `${LXC_PREFIX}${name}`;

  async function instanceOrError(name) {
    const r = await fetchLxcInstance(incus(name));
    if (r.error) return { error: `Could not inspect ${name}: ${r.error}` };
    if (r.notFound) return { error: `Container ${name} not found — list_lxc_containers shows valid names` };
    return { instance: r.instance, detail: lxcContainerDetail(r.instance) };
  }

  /**
   * The synchronous export every destructive verb takes first. Compression
   * comes from the same setting the dashboard uses (zstd by default — gzip
   * is single-threaded at ~50 MB/s and was costing 47 s on a 1 GB guest),
   * falling back to gzip on a host with no zstd binary, and the artifact is
   * registered so it appears in the one prepared-downloads list.
   */
  async function exportContainer(name, { snapshot = null, instanceOnly = false, compression = null, actor = null } = {}) {
    await exportsDir();
    await hostSh('mkdir -p "$1" && chmod 750 "$1"', [EXPORTS], { timeoutMs: 10000 });
    const picked = await resolveCompression({
      requested: compression,
      setting: (() => { try { return ctx.getSetting?.(COMPRESSION_SETTING) ?? null; } catch { return null; } })(),
      hasBinary: async (b) => (await runHostCapture('sh', ['-c', `command -v ${JSON.stringify(b)}`], { timeoutMs: 10000 })).status === 0,
    });
    const file = `${EXPORTS}/lxc-${name}${snapshot ? `-${snapshot}` : ''}-${stamp()}${picked.extension}`;
    const argv = ['export', snapshot ? `${incus(name)}/${snapshot}` : incus(name), file, ...incusCompressionArgs(picked.compression)];
    if (instanceOnly) argv.push('--instance-only');
    const r = await runHostCapture('incus', argv, { timeoutMs: 45 * 60 * 1000 });
    if (r.status !== 0) return { error: `incus export failed: ${tail(r.stderr) || (r.timedOut ? 'timed out' : 'unknown error')}` };
    const st = await hostSh('stat -c %s "$1" && sha256sum "$1" | cut -d" " -f1', [file], { timeoutMs: 10 * 60 * 1000 });
    const [size, sha] = (st.stdout || '').trim().split('\n');
    const out = {
      file, size_bytes: Number(size) || null, sha256: /^[0-9a-f]{64}$/.test(sha || '') ? sha : null,
      compression: picked.compression, compression_note: picked.note || null,
    };
    try {
      exportStore().register({
        container: name, snapshot, path: file, compression: picked.compression,
        sizeBytes: out.size_bytes, sha256: out.sha256, actor,
      });
    } catch { /* the tarball exists either way; the list is a convenience */ }
    return out;
  }

  /* ------------------------ delete / clone / export ----------------------- */

  const delete_lxc_container = mutation('delete_lxc_container', { subjectType: 'lxc', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const snapshots = inst.detail.snapshots;
    const wantExport = args.export !== false;
    await exportsDir();
    if (!snapshots.length) {
      note.refused = true;
      return err(`Refusing to delete ${name}: it has no snapshot. Take one with snapshot_lxc_container first — the snapshot is what the export tarball is cut from, and deleting a guest that was never snapshotted leaves nothing to come back to.`);
    }
    const bound = getDb().prepare(`SELECT DISTINCT r.domain FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE s.lxc_container_name = ?`).all(name).map((r) => r.domain);
    const plan = { container: name, status: inst.detail.status, snapshots: snapshots.map((s) => s.name), routes_removed: bound, export: wantExport ? `${EXPORTS}/lxc-${name}-<timestamp>.tar.zst (the exports.compression setting picks the compressor)` : 'SKIPPED (export: false)' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'delete_lxc_container', subject: name, action: `delete container ${name} (${bound.length} route(s) removed, ${snapshots.length} snapshot(s) lost with it)`, preview: plan });
    if (gate) return gate;
    let exported = null;
    if (wantExport) {
      exported = await exportContainer(name);
      if (exported.error) return err(`Nothing was deleted: ${exported.error}`);
      note.snapshot = exported.file;
    } else {
      note.detail.export_skipped = true;
    }
    if (inst.detail.status === 'Running') {
      const stop = await runHostCapture('incus', ['stop', incus(name), ...(args.force === true ? ['--force'] : [])], { timeoutMs: 180000 });
      if (stop.status !== 0) return err(`Could not stop ${name} cleanly (${tail(stop.stderr) || 'timed out'}). Pass force: true to stop it hard, or stop it yourself first.${exported ? ` Export kept at ${exported.file}.` : ''}`);
    }
    const del = await runHostCapture('incus', ['delete', incus(name)], { timeoutMs: 300000 });
    if (del.status !== 0) return err(`incus delete failed: ${tail(del.stderr)}${exported ? ` Export kept at ${exported.file}.` : ''}`);
    const db = getDb();
    const cleanup = { domains_rerendered: [], errors: [] };
    try {
      db.prepare(`DELETE FROM services WHERE lxc_container_name = ?`).run(name);
      for (const domain of bound) {
        try { await regenerateDomainCaddyConfig(db, domain); cleanup.domains_rerendered.push(domain); } catch (e) { cleanup.errors.push(`${domain}: ${e?.message || e}`); }
      }
      if (bound.length) { try { await caddyReload({}); } catch (e) { cleanup.errors.push(`caddy reload: ${e?.message || e}`); } }
      try { db.prepare(`DELETE FROM lxc_command_allowlists WHERE container_name = ?`).run(name); } catch { /* optional table */ }
    } catch (e) { cleanup.errors.push(e?.message || String(e)); }
    note.summary = `deleted container ${name}`;
    note.detail = { ...note.detail, routes_removed: bound, export: exported?.file || null };
    return ok({ deleted: true, container: name, export: exported, routes_removed: bound, ...cleanup, reverse_with: exported ? `import_lxc({ name: "${name}", file: "${exported.file.slice(EXPORTS.length + 1)}", confirm: true })` : null });
  });

  const clone_lxc_container = mutation('clone_lxc_container', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    const newName = String(args.new_name || '');
    if (!name) return err('Invalid container name');
    if (!LXC_NAME_REGEX.test(newName) || newName.length > 60) return err('new_name must be alphanumeric plus hyphens');
    note.subject_id = newName;
    const src = await instanceOrError(name);
    if (src.error) return err(src.error);
    const taken = await fetchLxcInstance(incus(newName));
    if (taken.instance) return err(`Container ${newName} already exists`);
    let snap = args.snapshot ? validSnapshotName(args.snapshot) : null;
    if (args.snapshot && !snap) return err('snapshot name is invalid');
    if (snap && !src.detail.snapshots.some((s) => s.name === snap)) return err(`Snapshot ${snap} does not exist on ${name}`);
    const plan = { from: snap ? `${name}/${snap}` : name, to: newName, start: args.start === true };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `This copies ${plan.from} to a new container ${newName}.`); if (gate) return gate;
    const r = await runHostCapture('incus', ['copy', snap ? `${incus(name)}/${snap}` : incus(name), incus(newName)], { timeoutMs: 30 * 60 * 1000 });
    if (r.status !== 0) return err(`incus copy failed: ${tail(r.stderr) || (r.timedOut ? 'timed out' : 'unknown error')}`);
    let started = false;
    if (args.start === true) {
      const s = await runHostCapture('incus', ['start', incus(newName)], { timeoutMs: 120000 });
      started = s.status === 0;
    }
    note.summary = `cloned ${plan.from} → ${newName}`;
    note.detail = plan;
    return ok({ cloned: true, from: plan.from, container: newName, started, note: 'The clone keeps the source\'s config and devices, including any static IP pin — set_lxc_network before routing to it.' });
  });

  const export_lxc = mutation('export_lxc', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const snap = args.snapshot ? validSnapshotName(args.snapshot) : null;
    if (args.snapshot && !snap) return err('snapshot name is invalid');
    if (snap && !inst.detail.snapshots.some((s) => s.name === snap)) return err(`Snapshot ${snap} does not exist on ${name}`);
    const plan = { container: name, snapshot: snap, instance_only: args.instance_only === true, directory: await exportsDir() };
    const d = dry(args, plan); if (d) return d;
    const out = await exportContainer(name, { snapshot: snap, instanceOnly: args.instance_only === true, compression: args.compression || null, actor: auth?.created_by ?? null });
    if (out.error) return err(out.error);
    note.snapshot = out.file;
    note.summary = `exported ${name}${snap ? `/${snap}` : ''}`;
    return ok({ exported: true, container: name, snapshot: snap, ...out, note: 'The tarball lives on the host under the ProxyPilot exports directory; import_lxc takes the file name, list_lxc_exports lists it and the dashboard can download it.' });
  });

  const import_lxc = mutation('import_lxc', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const newName = String(args.name || '');
    if (!LXC_NAME_REGEX.test(newName)) return err('name must be alphanumeric plus hyphens');
    note.subject_id = newName;
    const file = pathUnder(await exportsDir(), args.file);
    if (!file || !/\.tar(\.gz|\.xz|\.zst)?$/.test(file)) return err(`file must be a tarball name inside ${EXPORTS} (as returned by export_lxc / delete_lxc_container)`);
    const st = await hostSh('test -f "$1" && stat -c %s "$1"', [file], { timeoutMs: 10000 });
    if (st.status !== 0) return err(`No such export: ${file}`);
    const taken = await fetchLxcInstance(incus(newName));
    if (taken.instance) return err(`Container ${newName} already exists — delete it or pick another name`);
    const plan = { file, container: newName, start: args.start !== false, size_bytes: Number((st.stdout || '').trim()) || null };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `This imports ${file} as a new container ${newName}.`); if (gate) return gate;
    const r = await runHostCapture('incus', ['import', file, incus(newName)], { timeoutMs: 45 * 60 * 1000 });
    if (r.status !== 0) return err(`incus import failed: ${tail(r.stderr) || (r.timedOut ? 'timed out' : 'unknown error')}`);
    let started = false;
    if (args.start !== false) {
      const s = await runHostCapture('incus', ['start', incus(newName)], { timeoutMs: 120000 });
      started = s.status === 0;
    }
    note.summary = `imported ${newName} from ${file}`;
    note.detail = plan;
    return ok({ imported: true, container: newName, started, file, next: 'Routes that pointed at the deleted guest were removed with it — re-create them with set_route.' });
  });

  /* ------------------------------ snapshots ------------------------------ */

  const list_snapshots = reader('list_snapshots', async (args) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const ex = await hostSh('ls -1 "$1" 2>/dev/null | grep "^lxc-$2-" || true', [await exportsDir(), name], { timeoutMs: 10000 });
    return ok({ container: name, status: inst.detail.status, snapshots: inst.detail.snapshots, exports: (ex.stdout || '').trim().split('\n').filter(Boolean) });
  });

  const restore_snapshot = mutation('restore_snapshot', { subjectType: 'lxc', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const snap = validSnapshotName(args.snapshot);
    if (!snap) return err('snapshot is required');
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const target = inst.detail.snapshots.find((s) => s.name === snap);
    if (!target) return err(`Snapshot ${snap} does not exist on ${name} (list_snapshots)`);
    const plan = { container: name, restore_to: snap, snapshot_created_at: target.created_at, pre_restore_snapshot: `pp-mcp-pre-restore-<timestamp>`, note: 'The current state is snapshotted first, so the restore itself is reversible.' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'restore_snapshot', subject: `${name}/${snap}`, action: `restore ${name} to snapshot ${snap} (everything written since is replaced)`, preview: plan });
    if (gate) return gate;
    const pre = await takeLxcSnapshot(incus(name), defaultSnapshotName(new Date(), 'pp-mcp-pre-restore'));
    if (pre.error) return err(`Refusing to restore without a pre-restore snapshot: ${pre.error}`);
    note.snapshot = pre.name;
    const form = await resolveSnapshotCliForm();
    const r = await runHostCapture('incus', snapshotArgv('restore', incus(name), snap, form), { timeoutMs: 10 * 60 * 1000 });
    if (r.status !== 0) return err(`incus snapshot restore failed: ${tail(r.stderr) || 'unknown error'} (pre-restore snapshot ${pre.name} was taken)`);
    note.summary = `restored ${name} to ${snap}`;
    note.detail = { restored_to: snap };
    return ok({ restored: true, container: name, snapshot: snap, pre_restore_snapshot: pre.name, reverse_with: `restore_snapshot({ container: "${name}", snapshot: "${pre.name}" })` });
  });

  const delete_snapshot = mutation('delete_snapshot', { subjectType: 'lxc', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const snap = validSnapshotName(args.snapshot);
    if (!snap) return err('snapshot is required');
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    if (!inst.detail.snapshots.some((s) => s.name === snap)) return err(`Snapshot ${snap} does not exist on ${name}`);
    const plan = { container: name, delete: snap, remaining: inst.detail.snapshots.filter((s) => s.name !== snap).map((s) => s.name) };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `This deletes snapshot ${snap} of ${name}; ${plan.remaining.length} snapshot(s) remain.`); if (gate) return gate;
    const form = await resolveSnapshotCliForm();
    const r = await runHostCapture('incus', snapshotArgv('delete', incus(name), snap, form), { timeoutMs: 5 * 60 * 1000 });
    if (r.status !== 0) return err(`incus snapshot delete failed: ${tail(r.stderr) || 'unknown error'}`);
    note.summary = `deleted snapshot ${snap} of ${name}`;
    note.detail = plan;
    return ok({ deleted: true, container: name, snapshot: snap, remaining: plan.remaining });
  });

  /* -------------------------- resources / devices ------------------------- */

  const set_lxc_resources = mutation('set_lxc_resources', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const changes = [];
    if (args.cpu != null) { const n = intIn(args.cpu, 1, 256); if (!n) return err('cpu must be an integer 1–256'); changes.push({ key: 'limits.cpu', value: String(n) }); }
    if (args.memory_mb != null) { const n = intIn(args.memory_mb, 64, 1048576); if (!n) return err('memory_mb must be an integer 64–1048576'); changes.push({ key: 'limits.memory', value: `${n}MiB` }); }
    let disk = null;
    if (args.disk_gb != null) { disk = intIn(args.disk_gb, 1, 65536); if (!disk) return err('disk_gb must be an integer 1–65536'); }
    if (!changes.length && !disk) return err('Nothing to set: pass cpu, memory_mb and/or disk_gb');
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const plan = { container: name, config: changes, root_disk_size: disk ? `${disk}GiB` : null, current: inst.detail.config, snapshot_first: true };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Resources on ${name}: ${changes.map((c) => `${c.key}=${c.value}`).join(', ')}${disk ? `, root disk ${disk}GiB` : ''}.`); if (gate) return gate;
    const snap = await takeLxcSnapshot(incus(name), defaultSnapshotName(new Date(), 'pp-mcp-pre-resources'));
    if (snap.error) return err(`Refusing to change resources without a snapshot: ${snap.error}`);
    note.snapshot = snap.name;
    const applied = [];
    for (const c of changes) {
      const r = await runHostCapture('incus', ['config', 'set', incus(name), c.key, c.value], { timeoutMs: 60000 });
      if (r.status !== 0) return err(`incus config set ${c.key} failed: ${tail(r.stderr)} (applied so far: ${applied.join(', ') || 'none'}; snapshot ${snap.name})`);
      applied.push(`${c.key}=${c.value}`);
    }
    if (disk) {
      const r = await runHostCapture('incus', ['config', 'device', 'override', incus(name), 'root', `size=${disk}GiB`], { timeoutMs: 60000 });
      if (r.status !== 0) {
        const r2 = await runHostCapture('incus', ['config', 'device', 'set', incus(name), 'root', 'size', `${disk}GiB`], { timeoutMs: 60000 });
        if (r2.status !== 0) return err(`root disk resize failed: ${tail(r2.stderr) || tail(r.stderr)} (config applied: ${applied.join(', ') || 'none'}; snapshot ${snap.name}). Shrinking a volume is refused by most storage drivers.`);
      }
      applied.push(`root.size=${disk}GiB`);
    }
    note.summary = `resources on ${name}: ${applied.join(', ')}`;
    note.detail = { applied };
    return ok({ applied, container: name, snapshot: snap.name, restart_required: false, note: 'limits.* take effect live; a disk grow is live too, shrinking is refused by the driver.' });
  });

  const add_lxc_device = mutation('add_lxc_device', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const dev = String(args.device || '');
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(dev)) return err('device must be a short lowercase name (a-z, 0-9, -)');
    if (/^(root|eth0|ppl4-|ppcert-|reporepo)/.test(dev)) return err('That device name is reserved (root, eth0, ppl4-*, ppcert-*, reporepo are managed by ProxyPilot)');
    const type = String(args.type || '');
    let props;
    if (type === 'disk') {
      const source = String(args.source || '');
      const target = validTargetDir(args.path);
      const roots = policy.lxc_devices.disk_source_roots;
      if (!source.startsWith('/') || source.includes('..') || !roots.some((r) => source === r || source.startsWith(`${r}/`))) {
        return err(`disk source must be an absolute host path under one of: ${roots.join(', ')} (policy: mcp-extended-policy.json lxc_devices.disk_source_roots)`);
      }
      if (!target || target === '/') return err('path must be an absolute mount point inside the guest');
      props = { type: 'disk', source, path: target, ...(args.readonly === true ? { readonly: 'true' } : {}), ...(args.shift === true ? { shift: 'true' } : {}) };
    } else if (type === 'proxy') {
      const proto = args.protocol === 'udp' ? 'udp' : 'tcp';
      const { min, max } = policy.lxc_devices.proxy_listen_ports;
      const listen = intIn(args.listen_port, min, max);
      const connect = intIn(args.connect_port, 1, 65535);
      if (!listen) return err(`listen_port must be ${min}–${max}`);
      if (policy.lxc_devices.reserved_listen_ports.includes(listen)) return err(`listen_port ${listen} is reserved on this host`);
      if (!connect) return err('connect_port must be 1–65535');
      props = { type: 'proxy', listen: `${proto}:0.0.0.0:${listen}`, connect: `${proto}:127.0.0.1:${connect}` };
      note.detail.hint = 'For a forward the firewall should know about, set_port_forward is the managed path (it also survives reconciles).';
    } else {
      return err("type must be 'disk' or 'proxy'");
    }
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    if (inst.instance.devices && inst.instance.devices[dev]) return err(`Device ${dev} already exists on ${name} — remove_lxc_device first`);
    const plan = { container: name, device: dev, ...props };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Add ${type} device ${dev} to ${name}: ${JSON.stringify(props)}.`); if (gate) return gate;
    const snap = await takeLxcSnapshot(incus(name), defaultSnapshotName(new Date(), 'pp-mcp-pre-device'));
    if (snap.error) return err(`Refusing to add a device without a snapshot: ${snap.error}`);
    note.snapshot = snap.name;
    const kv = Object.entries(props).filter(([k]) => k !== 'type').map(([k, v]) => `${k}=${v}`);
    const r = await runHostCapture('incus', ['config', 'device', 'add', incus(name), dev, props.type, ...kv], { timeoutMs: 60000 });
    if (r.status !== 0) return err(`incus config device add failed: ${tail(r.stderr)} (snapshot ${snap.name})`);
    note.summary = `added ${type} device ${dev} to ${name}`;
    note.detail = { ...note.detail, ...plan };
    return ok({ added: true, ...plan, snapshot: snap.name, reverse_with: `remove_lxc_device({ container: "${name}", device: "${dev}", confirm: true })` });
  });

  const remove_lxc_device = mutation('remove_lxc_device', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const dev = String(args.device || '');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,40}$/.test(dev)) return err('device is required');
    if (/^(root|eth0|ppl4-|ppcert-|reporepo)/.test(dev)) return err('That device is managed by ProxyPilot (root/eth0/port forwards/cert mounts/project repo) — use the matching tool instead');
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const current = inst.instance.devices?.[dev];
    if (!current) return err(`Device ${dev} does not exist on ${name}. Devices: ${Object.keys(inst.instance.devices || {}).join(', ') || 'none'}`);
    const plan = { container: name, device: dev, current };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Remove device ${dev} (${current.type}) from ${name}.`); if (gate) return gate;
    const snap = await takeLxcSnapshot(incus(name), defaultSnapshotName(new Date(), 'pp-mcp-pre-device'));
    if (snap.error) return err(`Refusing to remove a device without a snapshot: ${snap.error}`);
    note.snapshot = snap.name;
    const r = await runHostCapture('incus', ['config', 'device', 'remove', incus(name), dev], { timeoutMs: 60000 });
    if (r.status !== 0) return err(`incus config device remove failed: ${tail(r.stderr)} (snapshot ${snap.name})`);
    note.summary = `removed device ${dev} from ${name}`;
    note.detail = plan;
    return ok({ removed: true, container: name, device: dev, previous: current, snapshot: snap.name });
  });

  const get_lxc_usage = reader('get_lxc_usage', async (args) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const st = inst.instance.state || {};
    const net = {};
    for (const [iface, v] of Object.entries(st.network || {})) {
      net[iface] = { rx_bytes: v.counters?.bytes_received ?? null, tx_bytes: v.counters?.bytes_sent ?? null, addresses: (v.addresses || []).filter((a) => a.family === 'inet').map((a) => a.address) };
    }
    return ok({
      container: name, status: inst.detail.status,
      cpu_seconds: st.cpu?.usage != null ? Math.round(st.cpu.usage / 1e9) : null,
      memory: { usage_bytes: st.memory?.usage ?? null, peak_bytes: st.memory?.usage_peak ?? null, swap_bytes: st.memory?.swap_usage ?? null, limit: inst.detail.config['limits.memory'] || null },
      disk: Object.fromEntries(Object.entries(st.disk || {}).map(([k, v]) => [k, { usage_bytes: v.usage ?? null }])),
      processes: st.processes ?? null,
      network: net,
      limits: Object.fromEntries(Object.entries(inst.detail.config).filter(([k]) => k.startsWith('limits.'))),
      devices: inst.instance.devices || {},
    });
  });

  /* ---------------------------- in-guest file ops ------------------------- */

  function guestPath(args, key = 'path') {
    const p = validLxcFilePath(args[key]);
    return p && p !== '/' ? p : null;
  }

  const delete_lxc_file = mutation('delete_lxc_file', { subjectType: 'lxc', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    const path = guestPath(args);
    if (!name) return err('Invalid container name');
    if (!path) return err('path must be an absolute path inside the guest (never /)');
    note.subject_id = name;
    const probe = await guestSh(name, 'p="$1"; if [ -d "$p" ]; then echo DIR; du -sk -- "$p" | cut -f1; elif [ -e "$p" ]; then echo FILE; stat -c %s -- "$p"; else echo ABSENT; fi', [path], { timeoutMs: 30000 });
    const [kind, size] = (probe.stdout || '').trim().split('\n');
    if (probe.status !== 0 || !kind) return err(`Could not inspect ${path}: ${tail(probe.stderr) || 'is the container running?'}`);
    if (kind === 'ABSENT') return err(`${path} does not exist — nothing to delete`);
    if (kind === 'DIR' && args.recursive !== true) return err(`${path} is a directory (${size} KB) — pass recursive: true to delete it and everything under it`);
    const keepOld = kind === 'FILE' && args.keep_old !== false;
    const plan = { container: name, path, kind: kind.toLowerCase(), size: kind === 'DIR' ? `${size} KB` : `${size} bytes`, backup: keepOld ? `${path}.old` : null };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Delete ${path} in ${name}${keepOld ? ` (a copy stays at ${path}.old)` : ' — no copy is kept'}.`); if (gate) return gate;
    const script = keepOld
      ? 'p="$1"; cp -p -- "$p" "$p.old" && rm -f -- "$p"'
      : 'p="$1"; rm -rf -- "$p"';
    const r = await guestSh(name, script, [path], { timeoutMs: 120000 });
    if (r.status !== 0) return err(`Delete failed: ${tail(r.stderr)}`);
    note.summary = `deleted ${path} in ${name}`;
    note.detail = plan;
    return ok({ deleted: true, ...plan, ...(keepOld ? { reverse_with: `restore_lxc_file({ container: "${name}", path: "${path}", confirm: true })` } : {}) });
  });

  const move_lxc_file = mutation('move_lxc_file', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    const from = guestPath(args, 'from');
    const to = guestPath(args, 'to');
    if (!name) return err('Invalid container name');
    if (!from || !to) return err('from and to must be absolute paths inside the guest');
    if (from === to) return err('from and to are the same path');
    note.subject_id = name;
    const plan = { container: name, from, to, overwrite: args.overwrite === true };
    const d = dry(args, plan); if (d) return d;
    const script = 'f="$1"; t="$2"; ow="$3"; test -e "$f" || { echo NOSRC >&2; exit 66; }; if [ -e "$t" ] && [ "$ow" != "1" ]; then echo EXISTS >&2; exit 67; fi; mkdir -p -- "$(dirname -- "$t")"; mv -f -- "$f" "$t"';
    const r = await guestSh(name, script, [from, to, args.overwrite === true ? '1' : '0'], { timeoutMs: 120000 });
    if (r.status === 66) return err(`${from} does not exist`);
    if (r.status === 67) return err(`${to} already exists — pass overwrite: true to replace it`);
    if (r.status !== 0) return err(`Move failed: ${tail(r.stderr)}`);
    note.summary = `moved ${from} → ${to} in ${name}`;
    note.detail = plan;
    return ok({ moved: true, ...plan, reverse_with: `move_lxc_file({ container: "${name}", from: "${to}", to: "${from}" })` });
  });

  const mkdir_lxc = mutation('mkdir_lxc', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    const path = guestPath(args);
    if (!name) return err('Invalid container name');
    if (!path) return err('path must be an absolute directory path inside the guest');
    note.subject_id = name;
    const mode = args.mode != null ? validOctalMode(args.mode) : null;
    if (args.mode != null && !mode) return err('mode must be octal, e.g. "0755"');
    const owner = args.owner != null ? String(args.owner) : null;
    if (owner && !/^[a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?$/.test(owner)) return err('owner must be user or user:group');
    const plan = { container: name, path, mode: mode || 'default', owner: owner || 'root' };
    const d = dry(args, plan); if (d) return d;
    const script = 'p="$1"; m="$2"; o="$3"; if [ -e "$p" ] && [ ! -d "$p" ]; then echo NOTDIR >&2; exit 67; fi; existed=0; [ -d "$p" ] && existed=1; mkdir -p -- "$p" || exit 1; [ -n "$m" ] && chmod "$m" -- "$p"; [ -n "$o" ] && chown "$o" -- "$p"; echo "existed=$existed"';
    const r = await guestSh(name, script, [path, mode || '', owner || ''], { timeoutMs: 30000 });
    if (r.status === 67) return err(`${path} exists and is not a directory`);
    if (r.status !== 0) return err(`mkdir failed: ${tail(r.stderr)}`);
    note.summary = `mkdir ${path} in ${name}`;
    note.detail = plan;
    return ok({ created: !/existed=1/.test(r.stdout), existed: /existed=1/.test(r.stdout), ...plan });
  });

  const chmod_lxc_file = mutation('chmod_lxc_file', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    const path = guestPath(args);
    if (!name) return err('Invalid container name');
    if (!path) return err('path must be an absolute path inside the guest');
    note.subject_id = name;
    const mode = args.mode != null ? validOctalMode(args.mode) : null;
    const owner = args.owner != null ? String(args.owner) : null;
    if (!mode && !owner) return err('Pass mode (octal, e.g. "0644") and/or owner (user or user:group)');
    if (args.mode != null && !mode) return err('mode must be octal, e.g. "0644"');
    if (owner && !/^[a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?$/.test(owner)) return err('owner must be user or user:group');
    const probe = await guestSh(name, 'p="$1"; test -e "$p" || exit 66; stat -c "%a %U:%G" -- "$p"', [path], { timeoutMs: 30000 });
    if (probe.status === 66) return err(`${path} does not exist`);
    if (probe.status !== 0) return err(`Could not stat ${path}: ${tail(probe.stderr)}`);
    const [curMode, curOwner] = (probe.stdout || '').trim().split(' ');
    const plan = { container: name, path, mode: mode || 'unchanged', owner: owner || 'unchanged', recursive: args.recursive === true, current: { mode: curMode, owner: curOwner } };
    const d = dry(args, plan); if (d) return d;
    const rec = args.recursive === true ? '-R' : '';
    const script = `p="$1"; m="$2"; o="$3"; [ -n "$m" ] && chmod ${rec} "$m" -- "$p"; [ -n "$o" ] && chown ${rec} "$o" -- "$p"; stat -c "%a %U:%G" -- "$p"`;
    const r = await guestSh(name, script, [path, mode || '', owner || ''], { timeoutMs: 120000 });
    if (r.status !== 0) return err(`chmod/chown failed: ${tail(r.stderr)}`);
    const [newMode, newOwner] = (r.stdout || '').trim().split(' ');
    note.summary = `chmod/chown ${path} in ${name}`;
    note.detail = plan;
    return ok({ applied: true, ...plan, result: { mode: newMode, owner: newOwner }, reverse_with: `chmod_lxc_file({ container: "${name}", path: "${path}", mode: "${curMode}", owner: "${curOwner}" })` });
  });

  const push_lxc_file_from_ticket = mutation('push_lxc_file_from_ticket', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    const path = guestPath(args);
    if (!name) return err('Invalid container name');
    if (!path) return err('path must be an absolute file path inside the guest');
    note.subject_id = name;
    const mode = args.mode != null ? validOctalMode(args.mode) : null;
    if (args.mode != null && !mode) return err('mode must be octal, e.g. "0755"');
    const exists = await guestSh(name, 'p="$1"; if [ -d "$p" ]; then echo DIR; elif [ -e "$p" ]; then echo FILE; else echo ABSENT; fi', [path], { timeoutMs: 30000 });
    const kind = (exists.stdout || '').trim();
    if (exists.status !== 0) return err(`Could not inspect ${path}: ${tail(exists.stderr) || 'is the container running?'}`);
    if (kind === 'DIR') return err(`${path} is a directory`);
    if (kind === 'FILE' && args.confirm_overwrite !== true) {
      note.refused = true;
      return err(`${path} already exists in ${name}. Re-call with confirm_overwrite: true to replace it (the previous file is kept as ${path}.old).`);
    }
    if (args.dry_run === true) return dry(args, { container: name, path, mode: mode || 'default', replaces_existing: kind === 'FILE', ticket: 'consumed on apply' });
    let bytes;
    try { bytes = await takeUploadTicket(args.ticket); } catch (e) { return err(e.message); }
    const sha = sha256Hex(bytes.buf);
    if (args.sha256 && String(args.sha256).toLowerCase() !== sha) return err(`Checksum mismatch: the uploaded bytes hash to ${sha}, you declared ${args.sha256}. Nothing was written — re-upload.`);
    // Stage next to the target, verify by size + sha256 inside the guest, then
    // move into place — the same discipline as write_lxc_file, for binaries.
    const script = [
      'p="$1"; sz="$2"; want="$3"; m="$4"; old="$5"',
      'tmp="$p.pp-push.$$"; mkdir -p -- "$(dirname -- "$p")" || exit 1',
      'cat > "$tmp" || { rm -f "$tmp"; exit 65; }',
      'got=$(wc -c < "$tmp"); [ "$got" = "$sz" ] || { rm -f "$tmp"; echo "size $got != $sz" >&2; exit 65; }',
      'h=$(sha256sum "$tmp" | cut -d" " -f1); [ "$h" = "$want" ] || { rm -f "$tmp"; echo "sha $h != $want" >&2; exit 65; }',
      '[ -n "$m" ] && chmod "$m" "$tmp"',
      '[ "$old" = "1" ] && [ -f "$p" ] && cp -p -- "$p" "$p.old"',
      'mv -f -- "$tmp" "$p" && sha256sum "$p" | cut -d" " -f1',
    ].join('\n');
    const r = await guestSh(name, script, [path, String(bytes.buf.length), sha, mode || '', kind === 'FILE' ? '1' : '0'], { input: bytes.buf, timeoutMs: 10 * 60 * 1000 });
    await bytes.discard();
    if (r.status === 65) return err(`The bytes that reached the guest did not verify (${tail(r.stderr)}). ${path} is untouched.`);
    if (r.status !== 0) return err(`Push failed: ${tail(r.stderr)}`);
    const landed = (r.stdout || '').trim().split('\n').pop();
    if (landed !== sha) return err(`Read-back hash ${landed} does not match ${sha} — inspect ${path} before using it.`);
    note.summary = `pushed ${bytes.buf.length} bytes to ${path} in ${name}`;
    note.detail = { path, bytes: bytes.buf.length, sha256: sha, replaced: kind === 'FILE' };
    return ok({ pushed: true, container: name, path, bytes: bytes.buf.length, sha256: sha, mode: mode || 'default', replaced: kind === 'FILE', ...(kind === 'FILE' ? { backup: `${path}.old` } : {}) });
  });

  /* ------------------------ services / processes / apt -------------------- */

  const service_control = mutation('service_control', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const unit = String(args.unit || '');
    if (!UNIT_NAME_RE.test(unit) || unit.length > 120) return err('unit must be a systemd unit name, e.g. nginx or myapp.service');
    const action = String(args.action || 'status');
    if (!policy.guest_services.actions.includes(action)) return err(`action must be one of ${policy.guest_services.actions.join(', ')}`);
    const readOnly = action === 'status' || action === 'is-active';
    if (!readOnly) {
      const d = dry(args, { container: name, unit, action }); if (d) return d;
      const gate = confirmFlag(args, note, `systemctl ${action} ${unit} inside ${name}.`); if (gate) return gate;
    }
    const r = await guestSh(name, 'a="$1"; u="$2"; o=$(mktemp); systemctl --no-pager --full "$a" "$u" >"$o" 2>&1; ec=$?; tail -c 16384 "$o"; rm -f "$o"; exit $ec', [action, unit], { timeoutMs: 120000 });
    const status = await guestSh(name, 'u="$1"; printf "%s\\n" "$(systemctl is-active "$u" 2>/dev/null || true)" "$(systemctl is-enabled "$u" 2>/dev/null || true)"', [unit], { timeoutMs: 30000 });
    const [active, enabled] = (status.stdout || '').trim().split('\n');
    if (!readOnly) { note.summary = `systemctl ${action} ${unit} in ${name}`; note.detail = { unit, action, active }; }
    return ok({ container: name, unit, action, exit_code: r.status, ok: r.status === 0, active: active || null, enabled: enabled || null, output: tail(r.stdout, 8000) });
  });

  const list_processes = reader('list_processes', async (args) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    const limit = intIn(args.limit, 1, 500) || 50;
    const sort = args.sort === 'memory' ? '-%mem' : args.sort === 'pid' ? 'pid' : '-%cpu';
    const r = await guestSh(name, 'n="$1"; s="$2"; ps -eo pid,ppid,user,%cpu,%mem,rss,etime,stat,args --sort="$s" 2>/dev/null | head -n "$((n + 1))"', [String(limit), sort], { timeoutMs: 30000 });
    if (r.status !== 0 || !r.stdout) return err(`Could not list processes: ${tail(r.stderr) || 'is the container running? (ps may be missing — install_package procps)'}`);
    const lines = r.stdout.trim().split('\n');
    const rows = lines.slice(1).map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), user: m[3], cpu_pct: Number(m[4]), mem_pct: Number(m[5]), rss_kb: Number(m[6]), elapsed: m[7], state: m[8], command: m[9].slice(0, 300) } : { raw: l };
    });
    return ok({ container: name, count: rows.length, sort: args.sort || 'cpu', processes: rows });
  });

  const install_package = mutation('install_package', { subjectType: 'lxc', flag: 'mcp.host_control' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const pkgs = Array.isArray(args.packages) ? args.packages.map(String) : [];
    if (!pkgs.length || pkgs.length > 20) return err('packages must be 1–20 package names');
    const bad = pkgs.filter((p) => !APT_PACKAGE_RE.test(p));
    if (bad.length) return err(`Not valid package names: ${bad.join(', ')}`);
    const denied = pkgs.filter((p) => !policy.apt_packages.allow.includes(p));
    if (denied.length) { note.refused = true; return err(`Not on the package allowlist: ${denied.join(', ')}. Allowed: ${policy.apt_packages.allow.join(', ')} (policy: mcp-extended-policy.json apt_packages.allow — extend it there, never on the wire).`); }
    const plan = { container: name, packages: pkgs, update_index: args.update !== false };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `apt-get install ${pkgs.join(' ')} inside ${name}.`); if (gate) return gate;
    const script = 'export DEBIAN_FRONTEND=noninteractive; upd="$1"; shift; command -v apt-get >/dev/null 2>&1 || { echo NOAPT >&2; exit 66; }; '
      + 'o=$(mktemp); if [ "$upd" = "1" ]; then apt-get -qq update >"$o" 2>&1 || { tail -c 4000 "$o" >&2; rm -f "$o"; exit 1; }; fi; '
      + 'apt-get install -y -q --no-install-recommends "$@" >"$o" 2>&1; ec=$?; tail -c 8000 "$o"; rm -f "$o"; exit $ec';
    const r = await guestSh(name, script, [args.update !== false ? '1' : '0', ...pkgs], { timeoutMs: 20 * 60 * 1000 });
    if (r.status === 66) return err('apt-get is not available in this guest (not a Debian/Ubuntu image)');
    if (r.status !== 0) return err(`apt-get install failed (exit ${r.status}): ${tail(r.stderr, 1500) || tail(r.stdout, 1500)}`);
    const versions = await guestSh(name, 'dpkg-query -W -f \'${binary:Package}\\t${Version}\\n\' "$@" 2>/dev/null', pkgs, { timeoutMs: 30000 });
    note.summary = `installed ${pkgs.join(', ')} in ${name}`;
    note.detail = plan;
    return ok({ installed: true, container: name, packages: (versions.stdout || '').trim().split('\n').filter(Boolean).map((l) => { const [n, v] = l.split('\t'); return { name: n, version: v }; }), output_tail: tail(r.stdout, 2000), note: 'Package installs are not recorded in the guest\'s startup script — add them there too if the guest is rebuilt from it.' });
  });

  /* ------------------------- per-guest command allowlist ------------------ */

  function readAllowlist(name) {
    try {
      const row = getDb().prepare(`SELECT * FROM lxc_command_allowlists WHERE container_name = ?`).get(name);
      if (!row) return { read_only: [], mutating: [], updated_at: null, updated_by: null };
      return { read_only: JSON.parse(row.read_only_json || '[]'), mutating: JSON.parse(row.mutating_json || '[]'), updated_at: row.updated_at, updated_by: row.updated_by };
    } catch { return { read_only: [], mutating: [], updated_at: null, updated_by: null }; }
  }

  const get_command_allowlist = reader('get_command_allowlist', async (args) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    const extra = readAllowlist(name);
    const base = ctx.LXC_CMD_POLICY;
    return ok({
      container: name,
      guest_additions: extra,
      base_read_only: base.read_only, base_mutating_scoped: base.mutating_scoped.commands, deny_always: base.deny_always.commands,
      note: 'Effective allowlist = base ∪ guest additions, with deny_always winning over everything. Guest mutating additions are allowed only in the registered startup working dir, like the base ones.',
    });
  });

  const set_command_allowlist = mutation('set_command_allowlist', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const norm = (list, label) => {
      if (list == null) return null;
      if (!Array.isArray(list) || list.length > 50) return { error: `${label} must be an array of up to 50 argv prefixes` };
      const out = [];
      for (const entry of list) {
        const argv = Array.isArray(entry) ? entry.map(String) : String(entry).trim().split(/\s+/).filter(Boolean);
        if (!argv.length || argv.some((t) => !/^[A-Za-z0-9_./=:,@%+-]+$/.test(t))) return { error: `${label}: "${Array.isArray(entry) ? entry.join(' ') : entry}" has an unusable token (shell syntax is never allowlisted)` };
        const denied = ctx.LXC_CMD_POLICY.deny_always.commands.find((d) => d.every((t, i) => argv[i] === t));
        if (denied) return { error: `${label}: "${argv.join(' ')}" is in deny_always (${denied.join(' ')}) and cannot be allowlisted per guest` };
        out.push(argv);
      }
      return out;
    };
    const ro = norm(args.read_only, 'read_only');
    const mut = norm(args.mutating, 'mutating');
    if (ro?.error) return err(ro.error);
    if (mut?.error) return err(mut.error);
    const current = readAllowlist(name);
    const next = { read_only: ro ?? current.read_only, mutating: mut ?? current.mutating };
    const plan = { container: name, current: { read_only: current.read_only, mutating: current.mutating }, next };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Set the per-guest command allowlist for ${name} to ${next.read_only.length} read-only and ${next.mutating.length} mutating prefixes.`); if (gate) return gate;
    getDb().prepare(`INSERT INTO lxc_command_allowlists (container_name, read_only_json, mutating_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(container_name) DO UPDATE SET read_only_json = excluded.read_only_json, mutating_json = excluded.mutating_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(name, JSON.stringify(next.read_only), JSON.stringify(next.mutating), String(auth.created_by || 'mcp'), new Date().toISOString());
    note.summary = `command allowlist for ${name} updated`;
    note.detail = { read_only: next.read_only.map((a) => a.join(' ')), mutating: next.mutating.map((a) => a.join(' ')) };
    return ok({ set: true, container: name, ...next, note: 'Takes effect on the next run_lxc_command call.' });
  });

  /* --------------------------------- egress ------------------------------- */

  async function proxypilotCli(argv) {
    const r = await runHostCapture(PROXYPILOT_BIN, ['--json', 'firewall', ...argv], { timeoutMs: 60000 });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout || ''); } catch { parsed = null; }
    if (!parsed) return { error: tail(r.stderr) || tail(r.stdout) || `proxypilot firewall ${argv.join(' ')} failed (exit ${r.status})` };
    if (parsed.ok === false) return { error: parsed.error || parsed.reason || 'refused by the firewall CLI' };
    return { result: parsed };
  }

  const get_lxc_egress = reader('get_lxc_egress', async (args) => {
    const name = args.container != null ? nameOf(args) : '';
    if (args.container != null && !name) return err('Invalid container name');
    const r = await proxypilotCli(['egress', 'list']);
    if (r.error) return err(`Could not read egress rules: ${r.error}`);
    const entries = (r.result.entries || []).filter((e) => !name || e.container === name || e.container === incus(name));
    return ok({ container: name || null, entries, known_services: r.result.services || null, note: 'Default-deny applies to every bridge → host flow that is not listed.' });
  });

  const set_lxc_egress = mutation('set_lxc_egress', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const action = args.action === 'deny' ? 'deny' : args.action === 'allow' ? 'allow' : null;
    if (!action) return err("action must be 'allow' or 'deny'");
    const service = String(args.service || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(service)) return err('service is required (a named service such as dns, http, smtp, or proto:port)');
    const reason = args.reason != null ? String(args.reason).slice(0, 200) : null;
    const plan = { container: name, action, service, reason };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `${action} egress ${service} for ${name}.`); if (gate) return gate;
    const argv = ['egress', action, name, service];
    if (action === 'allow' && reason) argv.push('--reason', reason);
    const r = await proxypilotCli(argv);
    if (r.error) return err(`Egress ${action} failed: ${r.error}`);
    note.summary = `egress ${action} ${service} for ${name}`;
    note.detail = plan;
    return ok({ applied: true, ...plan, reconcile: r.result.reconcile || null, reverse_with: `set_lxc_egress({ container: "${name}", action: "${action === 'allow' ? 'deny' : 'allow'}", service: "${service}", confirm: true })` });
  });

  /* ----------------------------- port forwards ---------------------------- */

  const set_port_forward = mutation('set_port_forward', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const db = getDb();
    const action = String(args.action || 'add');
    const service = db.prepare(`SELECT * FROM services WHERE lxc_container_name = ? AND is_admin = 0 LIMIT 1`).get(name);
    if (action === 'list') {
      const rows = service ? db.prepare(`SELECT * FROM service_l4_forwards WHERE service_id = ? ORDER BY proto, listen_port`).all(service.id) : [];
      return ok({ container: name, forwards: rows });
    }
    if (action === 'remove') {
      const id = String(args.forward_id || '');
      const row = service ? db.prepare(`SELECT * FROM service_l4_forwards WHERE id = ? AND service_id = ?`).get(id, service.id) : null;
      if (!row) return err('forward_id not found on this container (action: "list" shows them)');
      const d = dry(args, { container: name, remove: row }); if (d) return d;
      const gate = confirmFlag(args, note, `Remove the ${row.proto}/${row.listen_port} forward from ${name}.`); if (gate) return gate;
      db.prepare(`DELETE FROM service_l4_forwards WHERE id = ?`).run(id);
      const inst = await instanceOrError(name);
      const bridgeIp = inst.detail?.primary_address || service.target_ip || null;
      let reconcile = null;
      try { reconcile = await reconcileServiceL4Forwards({ db, serviceId: service.id, lxcName: name, bridgeIp, serviceTag: service.name || null }); } catch (e) { reconcile = { error: e?.message || String(e) }; }
      note.summary = `removed ${row.proto}/${row.listen_port} forward on ${name}`;
      note.detail = { removed: row };
      return ok({ removed: true, container: name, forward: row, reconcile });
    }
    if (action !== 'add') return err("action must be 'add', 'remove' or 'list'");
    const proto = args.protocol === 'udp' ? 'udp' : 'tcp';
    const listen = intIn(args.listen_port, 1, 65535);
    const connect = intIn(args.connect_port, 1, 65535) || listen;
    const listenEnd = args.listen_port_end != null ? intIn(args.listen_port_end, 1, 65535) : null;
    const connectEnd = args.connect_port_end != null ? intIn(args.connect_port_end, 1, 65535) : (listenEnd ? connect + (listenEnd - listen) : null);
    if (!listen) return err('listen_port must be 1–65535');
    if (listenEnd != null && (listenEnd < listen || (connectEnd - connect) !== (listenEnd - listen))) return err('listen and connect port ranges must be the same width');
    if (policy.lxc_devices.reserved_listen_ports.includes(listen)) return err(`listen_port ${listen} is reserved on this host`);
    const inst = await instanceOrError(name);
    if (inst.error) return err(inst.error);
    const bridgeIp = inst.detail.primary_address || service?.target_ip || null;
    if (!bridgeIp) return err(`${name} has no host-reachable IPv4 address — is it running?`);
    const plan = { container: name, proto, listen: listenEnd ? `${listen}-${listenEnd}` : listen, connect: connectEnd ? `${connect}-${connectEnd}` : connect, bridge_ip: bridgeIp, description: args.description ? String(args.description).slice(0, 255) : null };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Forward host ${proto}/${plan.listen} → ${name}:${plan.connect} (Incus proxy device + firewall rule).`); if (gate) return gate;
    const svc = service || findOrCreateLxcService(db, name, bridgeIp);
    const id = ctx.uuidv4();
    try {
      db.prepare(`INSERT INTO service_l4_forwards (id, service_id, proto, listen_port, listen_port_end, connect_port, connect_port_end, description, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(id, svc.id, proto, listen, listenEnd, connect, connectEnd, plan.description);
    } catch (e) {
      if (/UNIQUE constraint/i.test(e.message)) return err(`Another forward already binds ${proto}/${plan.listen}`);
      throw e;
    }
    let reconcile;
    try {
      reconcile = await reconcileServiceL4Forwards({ db, serviceId: svc.id, lxcName: name, bridgeIp, serviceTag: svc.name || null });
    } catch (e) {
      db.prepare(`DELETE FROM service_l4_forwards WHERE id = ?`).run(id);
      return err(`L4 reconcile failed: ${e?.message || e} — the forward row was rolled back`);
    }
    const mine = (reconcile.applied || []).find((o) => o.id === id);
    if (mine && mine.status === 'error') {
      db.prepare(`DELETE FROM service_l4_forwards WHERE id = ?`).run(id);
      return err(`L4 apply failed: ${mine.error} — the forward row was rolled back`);
    }
    note.summary = `forward ${proto}/${plan.listen} → ${name}:${plan.connect}`;
    note.detail = plan;
    return ok({ added: true, forward_id: id, ...plan, reconcile, reverse_with: `set_port_forward({ container: "${name}", action: "remove", forward_id: "${id}", confirm: true })` });
  });

  /* ---------------------------------- cron -------------------------------- */

  const list_cron = reader('list_cron', async (args) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    const user = args.user != null ? String(args.user) : 'root';
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return err('user must be a unix user name');
    const r = await guestSh(name, 'u="$1"; command -v crontab >/dev/null 2>&1 || { echo NOCRON >&2; exit 66; }; crontab -u "$u" -l 2>/dev/null || true; echo "__PP_SYSTEM__"; ls -1 /etc/cron.d 2>/dev/null || true', [user], { timeoutMs: 30000 });
    if (r.status === 66) return err('crontab is not installed in this guest (install_package cron)');
    const [userPart, sysPart] = (r.stdout || '').split('__PP_SYSTEM__');
    const entries = (userPart || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    return ok({ container: name, user, crontab: (userPart || '').trimEnd(), entries: entries.map((l) => l.trim()), system_cron_d: (sysPart || '').trim().split('\n').filter(Boolean) });
  });

  const set_cron = mutation('set_cron', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const name = nameOf(args);
    if (!name) return err('Invalid container name');
    note.subject_id = name;
    const user = args.user != null ? String(args.user) : 'root';
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return err('user must be a unix user name');
    let text;
    if (typeof args.crontab === 'string') text = args.crontab;
    else if (Array.isArray(args.entries)) text = args.entries.map(String).join('\n');
    else return err('Pass crontab (the whole file) or entries (an array of lines); an empty crontab clears it');
    text = text.replace(/\r\n/g, '\n').trimEnd();
    const lines = text.split('\n').filter((l) => l.trim());
    const bad = lines.filter((l) => !l.trim().startsWith('#') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l.trim()) && !CRON_LINE_RE.test(l.trim()));
    if (bad.length) return err(`Not valid crontab lines: ${bad.slice(0, 3).map((l) => JSON.stringify(l)).join(', ')}`);
    const current = await guestSh(name, 'u="$1"; command -v crontab >/dev/null 2>&1 || { echo NOCRON >&2; exit 66; }; crontab -u "$u" -l 2>/dev/null || true', [user], { timeoutMs: 30000 });
    if (current.status === 66) return err('crontab is not installed in this guest (install_package cron)');
    const plan = { container: name, user, current_lines: (current.stdout || '').split('\n').filter((l) => l.trim()).length, new_lines: lines.length, backup: `/var/backups/proxypilot-crontab.${user}.old` };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Replace ${user}'s crontab in ${name} with ${lines.length} line(s).`); if (gate) return gate;
    const script = 'u="$1"; mkdir -p /var/backups; crontab -u "$u" -l > "/var/backups/proxypilot-crontab.$u.old" 2>/dev/null || : > "/var/backups/proxypilot-crontab.$u.old"; crontab -u "$u" - || exit 1; crontab -u "$u" -l 2>/dev/null || true';
    const r = await guestSh(name, script, [user], { input: text ? `${text}\n` : '', timeoutMs: 30000 });
    if (r.status !== 0) return err(`crontab install failed: ${tail(r.stderr)} (previous crontab kept at ${plan.backup})`);
    note.summary = `crontab for ${user} in ${name} replaced (${lines.length} lines)`;
    note.detail = plan;
    return ok({ set: true, container: name, user, entries: (r.stdout || '').split('\n').filter((l) => l.trim()), backup: plan.backup });
  });

  /* --------------------------- prepared downloads ------------------------ */

  const list_lxc_exports = reader('list_lxc_exports', async (args) => {
    const store = exportStore();
    const rows = store.list({ container: args.container ? String(args.container) : null, state: args.state ? String(args.state) : null });
    return ok({
      count: rows.length,
      exports: rows,
      directory: await exportsDir(),
      queue: store.queueStatus(),
      note: 'One row per tarball that exists on disk: export_lxc writes them, the dashboard prepares them in the background, and both show the same list. Retention keeps the newest few per container. import_lxc takes the filename; the dashboard can download it as many times as you like.',
    });
  });

  const delete_lxc_export = mutation('delete_lxc_export', { subjectType: 'lxc' }, async (args, auth, req, note) => {
    const store = exportStore();
    const row = store.get(args.id);
    if (!row) return err(`no prepared download ${args.id} (list_lxc_exports)`);
    note.subject_id = row.container;
    const d = dry(args, { id: row.id, container: row.container, file: row.filename, bytes: row.bytes, state: row.state });
    if (d) return d;
    const gate = confirmFlag(args, note, `This deletes the tarball ${row.filename} (${row.bytes ? `${Math.round(row.bytes / 1024 ** 2)} MB` : 'size unknown'}). The container is untouched.`);
    if (gate) return gate;
    const out = await store.remove(row.id, { actor: auth?.created_by ?? null });
    if (out.error) { note.refused = true; return err(out.error); }
    note.summary = `deleted export ${row.filename}`;
    return ok({ ...out, container: row.container, note: 'The container and its snapshots are untouched — only the tarball is gone.' });
  });

  return {
    list_lxc_exports, delete_lxc_export,
    delete_lxc_container, clone_lxc_container, export_lxc, import_lxc,
    list_snapshots, restore_snapshot, delete_snapshot,
    set_lxc_resources, add_lxc_device, remove_lxc_device, get_lxc_usage,
    delete_lxc_file, move_lxc_file, mkdir_lxc, chmod_lxc_file, push_lxc_file_from_ticket,
    service_control, list_processes, install_package,
    get_command_allowlist, set_command_allowlist,
    get_lxc_egress, set_lxc_egress, set_port_forward,
    list_cron, set_cron,
  };
}
