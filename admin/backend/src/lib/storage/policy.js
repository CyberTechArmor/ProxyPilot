// ZFS storage management — backup policy (sanoid) and replication (syncoid)
// configuration, rendered from ProxyPilot's stored policy. Pure: the
// service writes what these functions return onto the host.
//
// Policy model (stored as one JSON document in app_settings):
//   {
//     classes:  { guests: {frequent, hourly, daily, monthly}, backups: {…}, exports: {…} },
//     datasets: { "<dataset>": { class?, enabled?, retention?: {…} } },
//     guests:   { "<guest>":   { enabled?, retention?: {…} } }
//   }
// Retention counts are sanoid's own: how many snapshots of each period to
// keep (frequent = every 15 minutes). Zero disables that period.

export const RETENTION_KEYS = Object.freeze(['frequent', 'hourly', 'daily', 'monthly']);
export const FREQUENT_PERIOD_MINUTES = 15;

export const DEFAULT_CLASSES = Object.freeze({
  guests: Object.freeze({ frequent: 4, hourly: 24, daily: 14, monthly: 3 }),
  backups: Object.freeze({ frequent: 0, hourly: 0, daily: 30, monthly: 6 }),
  exports: Object.freeze({ frequent: 0, hourly: 0, daily: 7, monthly: 1 }),
});

export const CLASS_NAMES = Object.freeze(Object.keys(DEFAULT_CLASSES));

function cleanRetention(r, base) {
  const out = { ...base };
  if (!r || typeof r !== 'object') return out;
  for (const k of RETENTION_KEYS) {
    if (r[k] == null) continue;
    const n = Number(r[k]);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error(`retention.${k} must be an integer 0–10000`);
    out[k] = n;
  }
  return out;
}

/** Merge a stored policy document with the defaults. Throws on a malformed document. */
export function resolvePolicy(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const classes = {};
  for (const c of CLASS_NAMES) classes[c] = cleanRetention(s.classes?.[c], DEFAULT_CLASSES[c]);
  const datasets = {};
  for (const [name, v] of Object.entries(s.datasets || {})) {
    if (!v || typeof v !== 'object') continue;
    datasets[name] = { class: CLASS_NAMES.includes(v.class) ? v.class : null, enabled: v.enabled !== false, retention: v.retention ? cleanRetention(v.retention, {}) : null };
  }
  const guests = {};
  for (const [name, v] of Object.entries(s.guests || {})) {
    if (!v || typeof v !== 'object') continue;
    guests[name] = { enabled: v.enabled !== false, retention: v.retention ? cleanRetention(v.retention, {}) : null };
  }
  return { classes, datasets, guests };
}

/**
 * Apply one update to a policy document. `update` is one of:
 *   { class: 'guests', retention: {…} }
 *   { dataset: 'tank/data', class?, enabled?, retention? }   (retention: null clears the override)
 *   { guest: 'web-1', enabled?, retention? }
 */
export function applyPolicyUpdate(stored, update = {}) {
  const p = resolvePolicy(stored);
  if (update.class != null && update.dataset == null && update.guest == null) {
    if (!CLASS_NAMES.includes(update.class)) throw new Error(`class must be one of ${CLASS_NAMES.join(', ')}`);
    p.classes[update.class] = cleanRetention(update.retention, p.classes[update.class]);
    return p;
  }
  if (update.dataset != null) {
    const name = String(update.dataset);
    const cur = p.datasets[name] || { class: null, enabled: true, retention: null };
    if (update.class !== undefined) { if (update.class != null && !CLASS_NAMES.includes(update.class)) throw new Error(`class must be one of ${CLASS_NAMES.join(', ')}`); cur.class = update.class; }
    if (update.enabled !== undefined) cur.enabled = update.enabled !== false;
    if (update.retention !== undefined) cur.retention = update.retention == null ? null : cleanRetention(update.retention, {});
    p.datasets[name] = cur;
    return p;
  }
  if (update.guest != null) {
    const name = String(update.guest);
    const cur = p.guests[name] || { enabled: true, retention: null };
    if (update.enabled !== undefined) cur.enabled = update.enabled !== false;
    if (update.retention !== undefined) cur.retention = update.retention == null ? null : cleanRetention(update.retention, {});
    p.guests[name] = cur;
    return p;
  }
  throw new Error('update needs class, dataset or guest');
}

/** The class a dataset falls in under a managed layout { incus, backups, exports } (dataset names). */
export function classForDataset(name, managed, policy) {
  const override = policy?.datasets?.[name]?.class;
  if (override) return override;
  if (!managed) return null;
  if (managed.incus && (name === managed.incus || name.startsWith(`${managed.incus}/`))) return 'guests';
  if (managed.backups && (name === managed.backups || name.startsWith(`${managed.backups}/`))) return 'backups';
  if (managed.exports && (name === managed.exports || name.startsWith(`${managed.exports}/`))) return 'exports';
  return null;
}

/** Effective retention for a dataset (class defaults + dataset override + guest override). */
export function effectiveRetention(name, { managed, policy, guest = null }) {
  const cls = classForDataset(name, managed, policy);
  let ret = cls ? { ...policy.classes[cls] } : null;
  const dOv = policy.datasets?.[name];
  if (dOv?.retention) ret = { ...(ret || {}), ...dOv.retention };
  if (guest && policy.guests?.[guest]?.retention) ret = { ...(ret || {}), ...policy.guests[guest].retention };
  const enabled = (dOv ? dOv.enabled : true) && (guest && policy.guests?.[guest] ? policy.guests[guest].enabled : true);
  return { class: cls, enabled, retention: ret };
}

function section(name, body) {
  return `[${name}]\n${Object.entries(body).map(([k, v]) => `\t${k} = ${v}`).join('\n')}\n`;
}

/**
 * Render /etc/sanoid/sanoid.conf. `managed` = { incus, backups, exports }
 * dataset names (any may be null); `guestDatasets` = [{ guest, dataset }] so a
 * per-guest override becomes its own section. Extra datasets in
 * policy.datasets that are outside the managed tree get their own section too.
 */
export function renderSanoidConf({ policy, managed = {}, guestDatasets = [] }) {
  const p = resolvePolicy(policy);
  const out = ['# Generated by ProxyPilot (Storage → Backup policy). Edits here are overwritten on the next policy change.', ''];
  const templates = {};
  for (const c of CLASS_NAMES) {
    templates[`pp_${c}`] = p.classes[c];
    out.push(section(`template_pp_${c}`, { frequently: p.classes[c].frequent, frequent_period: FREQUENT_PERIOD_MINUTES, hourly: p.classes[c].hourly, daily: p.classes[c].daily, monthly: p.classes[c].monthly, yearly: 0, autosnap: 'yes', autoprune: 'yes' }));
  }
  const tree = [['incus', 'guests'], ['backups', 'backups'], ['exports', 'exports']];
  const written = new Set();
  for (const [key, cls] of tree) {
    const ds = managed[key];
    if (!ds) continue;
    const ov = p.datasets[ds];
    const body = { use_template: `pp_${ov?.class || cls}`, recursive: key === 'incus' ? 'yes' : 'no', process_children_only: key === 'incus' ? 'yes' : 'no' };
    if (ov && ov.enabled === false) { body.autosnap = 'no'; body.autoprune = 'no'; }
    if (ov?.retention) for (const [k, v] of Object.entries(ov.retention)) body[k === 'frequent' ? 'frequently' : k] = v;
    out.push(section(ds, body)); written.add(ds);
  }
  for (const { guest, dataset } of guestDatasets) {
    const ov = p.guests[guest];
    if (!ov || written.has(dataset)) continue;
    const body = { use_template: 'pp_guests', recursive: 'no' };
    if (ov.enabled === false) { body.autosnap = 'no'; body.autoprune = 'no'; }
    if (ov.retention) for (const [k, v] of Object.entries(ov.retention)) body[k === 'frequent' ? 'frequently' : k] = v;
    out.push(section(dataset, body)); written.add(dataset);
  }
  for (const [ds, ov] of Object.entries(p.datasets)) {
    if (written.has(ds)) continue;
    const cls = ov.class || classForDataset(ds, managed, p) || 'backups';
    const body = { use_template: `pp_${cls}`, recursive: 'no' };
    if (ov.enabled === false) { body.autosnap = 'no'; body.autoprune = 'no'; }
    if (ov.retention) for (const [k, v] of Object.entries(ov.retention)) body[k === 'frequent' ? 'frequently' : k] = v;
    out.push(section(ds, body)); written.add(ds);
  }
  return out.join('\n');
}

/* ------------------------------ replication ------------------------------ */

export const SCHEDULES = Object.freeze({ hourly: 'hourly', daily: '*-*-* 02:30:00', weekly: 'Sun *-*-* 03:00:00' });
const CALENDAR_RE = /^[A-Za-z0-9 *:,./-]{1,80}$/;

/** Validate a replication target definition. Returns { config } or { error }. */
export function validateReplication(input = {}) {
  const name = String(input.name || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return { error: 'name: lowercase letters, digits, hyphens (1–41 chars)' };
  const sources = Array.isArray(input.sources) ? input.sources.map(String) : input.source ? [String(input.source)] : [];
  if (!sources.length) return { error: 'sources: at least one dataset to replicate' };
  for (const s of sources) if (!/^[A-Za-z][A-Za-z0-9_.:-]*(\/[A-Za-z0-9_.:-]+)*$/.test(s)) return { error: `source ${s} is not a dataset name` };
  const target = String(input.target || '').trim();
  // local: pool/dataset; remote: [user@]host:pool/dataset (host may be IPv4/IPv6/name)
  const local = /^[A-Za-z][A-Za-z0-9_.:-]*(\/[A-Za-z0-9_.:-]+)*$/.test(target) && !target.includes(':');
  const remote = /^([A-Za-z0-9._-]+@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):[A-Za-z][A-Za-z0-9_.:-]*(\/[A-Za-z0-9_.:-]+)*$/.test(target);
  if (!local && !remote) return { error: 'target must be pool/dataset (second local pool) or [user@]host:pool/dataset (remote over SSH)' };
  let sshKey = null;
  if (remote) {
    sshKey = String(input.ssh_key_path || '').trim();
    if (!sshKey.startsWith('/') || sshKey.includes('..') || /\s/.test(sshKey)) return { error: 'ssh_key_path: absolute path to the private key on the host (the key is never read or stored by ProxyPilot)' };
  }
  let schedule = String(input.schedule || 'hourly');
  if (SCHEDULES[schedule]) schedule = SCHEDULES[schedule];
  else if (!CALENDAR_RE.test(schedule) || !(/\d{1,2}:\d{2}/.test(schedule) || /^(minutely|hourly|daily|weekly|monthly|yearly|quarterly|semiannually|annually)$/.test(schedule))) return { error: 'schedule: hourly, daily, weekly or a systemd OnCalendar expression (e.g. *-*-* 02:30:00)' };
  const cfg = {
    name, sources, target, kind: remote ? 'remote' : 'local', ssh_key_path: sshKey, schedule,
    recursive: input.recursive !== false, ssh_port: input.ssh_port != null ? Number(input.ssh_port) : null, enabled: input.enabled !== false,
    extra_args: Array.isArray(input.extra_args) ? input.extra_args.map(String).filter((a) => /^--[a-z][a-z0-9-]*(=[A-Za-z0-9_.:/-]+)?$/.test(a)) : [],
  };
  if (cfg.ssh_port != null && (!Number.isInteger(cfg.ssh_port) || cfg.ssh_port < 1 || cfg.ssh_port > 65535)) return { error: 'ssh_port: 1–65535' };
  return { config: cfg };
}

/** /etc/proxypilot/storage/replication-<name>.conf — read by scripts/storage-replicate.sh (shell-safe, one KEY=value per line). */
export function renderReplicationConf(cfg) {
  const q = (v) => `'${String(v == null ? '' : v).replace(/'/g, "'\\''")}'`;
  return [
    '# Generated by ProxyPilot (Storage → Replication). The key file itself is never read by ProxyPilot.',
    `PP_REPL_NAME=${q(cfg.name)}`,
    `PP_REPL_SOURCES=${q(cfg.sources.join(' '))}`,
    `PP_REPL_TARGET=${q(cfg.target)}`,
    `PP_REPL_KIND=${q(cfg.kind)}`,
    `PP_REPL_SSH_KEY=${q(cfg.ssh_key_path || '')}`,
    `PP_REPL_SSH_PORT=${q(cfg.ssh_port || '')}`,
    `PP_REPL_RECURSIVE=${q(cfg.recursive ? '1' : '0')}`,
    `PP_REPL_EXTRA_ARGS=${q(cfg.extra_args.join(' '))}`,
    '',
  ].join('\n');
}

/** Timer drop-in so each replication job keeps its own schedule on the shared template unit. */
export function renderTimerDropIn(schedule) {
  return `# Generated by ProxyPilot\n[Timer]\nOnCalendar=\nOnCalendar=${schedule}\nRandomizedDelaySec=300\nPersistent=true\n`;
}

/** What "too old" means, from retention / schedule. */
export function snapshotMaxAgeMs(retention) {
  if (!retention) return null;
  if (retention.frequent > 0) return 4 * FREQUENT_PERIOD_MINUTES * 60 * 1000;   // 1 h
  if (retention.hourly > 0) return 3 * 3600 * 1000;
  if (retention.daily > 0) return 30 * 3600 * 1000;
  if (retention.monthly > 0) return 35 * 86400 * 1000;
  return null;
}

export function replicationMaxAgeMs(schedule) {
  const s = String(schedule || '');
  if (s === 'hourly' || /^\*-\*-\* \*:/.test(s)) return 3 * 3600 * 1000;
  if (/^[A-Z][a-z]{2} /.test(s) || s === 'weekly') return 8 * 86400 * 1000;
  return 30 * 3600 * 1000;
}

export const SCRUB_MAX_AGE_MS = 45 * 86400 * 1000;
