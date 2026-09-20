// The migration service: rows, tokens, the agent's job document, the event
// stream, and the Incus-side work (trust token, rootfs-tar import, guest
// creation, the fence). routes/migrations.js and the MCP `migration` family
// are both thin over this, so a migration driven from the dashboard and one
// driven from an agent land in the same table with the same rules.
//
// Everything that decides is in ./plan.js and ./manifest.js (pure, tested
// without a host); everything that touches the host is here, behind
// runHostCapture.

import { createHash } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import {
  validateManifest, manifestSummary, manifestConcerns, observedEgress, suggestedRoutes, databasePlan,
  capacityNeeds, capacityVerdict,
} from './manifest.js';
import {
  validateTarget, guestConfig, installCommand, installCommandTwoStep, checklistFor, checklistComplete,
  checklistProgress, transferProgress, PHASES, PHASE_IDS, canAdvance, TERMINAL, CHECKLIST,
} from './plan.js';
import { mintMigrationToken, verifyToken, parseToken, formatPin, tokenState, DEFAULT_TTL_SECONDS } from './token.js';

export const ARCHES = Object.freeze(['amd64', 'arm64']);
/** Where install.sh / update.sh drop the cross-built agents (scripts/build-migration-agent.sh). */
export const AGENT_DIR = process.env.PROXYPILOT_MIGRATION_AGENT_DIR || '/var/lib/proxypilot/agent';
export const WORK_DIR = process.env.PROXYPILOT_MIGRATION_WORK_DIR || '/var/lib/proxypilot/migration';
const EVENT_LIMIT = 5000;           // per migration; the agent's log is trimmed, not unbounded
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 4;
/** Directories that must never travel in a whole-machine rootfs tar. */
export const TAR_EXCLUDES = Object.freeze([
  './proc/*', './sys/*', './dev/*', './run/*', './tmp/*', './mnt/*', './media/*',
  './var/cache/apt/archives/*', './var/tmp/*', './swap.img', './swapfile', './lost+found',
]);

const nowIso = (t = Date.now()) => new Date(t).toISOString();
const j = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function createMigrationService({
  getDb, runHostCapture, publicBaseUrl, logAudit = () => {}, now = () => Date.now(), lxcPrefix = 'pp-',
  // Injected rather than read from the module constants so a test (and a
  // future packaging that moves them) does not depend on /var/lib being
  // writable by whoever is running.
  workDir = WORK_DIR, agentDir = AGENT_DIR,
} = {}) {
  if (typeof getDb !== 'function') throw new Error('createMigrationService needs getDb');
  if (typeof runHostCapture !== 'function') throw new Error('createMigrationService needs runHostCapture');

  const db = () => getDb();
  const exec = (bin, args, opts = {}) => runHostCapture(bin, args, { timeoutMs: 60000, ...opts });

  /* -------------------------------- rows -------------------------------- */

  function rowById(id) {
    return db().prepare('SELECT * FROM migrations WHERE id = ?').get(Number(id)) || null;
  }
  function rowByTokenId(tokenId) {
    return db().prepare('SELECT * FROM migrations WHERE token_id = ?').get(String(tokenId)) || null;
  }

  /** The public shape: never the token hash, never a raw secret. */
  function view(row, { events = 0, manifest = true } = {}) {
    if (!row) return null;
    const spec = parse(row.spec_json, {});
    const man = manifest ? parse(row.manifest_json, null) : null;
    const checklistState = parse(row.checklist_json, {}) || {};
    const egress = parse(row.egress_json, null);
    const samples = progressSamples(row.id);
    const prog = transferProgress({ samples, total_bytes: row.bytes_total ?? null, now: now() });
    // "Stalled" is a statement about a transfer in flight. On a finished or
    // waiting migration the last sample is always old, and saying stalled
    // there is just wrong.
    if (row.status !== 'running' || row.phase !== 'transfer') prog.stalled = false;
    return {
      id: row.id, created_at: row.created_at, created_by: row.created_by, updated_at: row.updated_at,
      mode: row.mode, transport: row.transport, status: row.status, phase: row.phase,
      phases: PHASES.map((p) => ({ ...p, state: phaseState(p.id, row) })),
      target: { name: row.target_name, ...guestConfig(spec, { prefix: '' }), incus_name: row.target_name },
      spec, source_label: row.source_label,
      token: { ...tokenState(row, { now: now() }), id: row.token_id, tls_pin: row.tls_pin },
      manifest: man, manifest_at: row.manifest_at,
      summary: man ? manifestSummary(man) : null,
      capacity: parse(row.capacity_json, null),
      concerns: man ? manifestConcerns(man, { mode: row.mode, capacity: parse(row.capacity_json, null) }) : [],
      approved_at: row.approved_at, approved_by: row.approved_by,
      egress: egress || (man ? observedEgress(man).map(defaultEgressDecision) : []),
      routes: man ? suggestedRoutes(man) : [],
      databases: man ? databasePlan(man) : [],
      checklist: checklistFor(row.mode, checklistState),
      checklist_progress: checklistProgress(row.mode, checklistState),
      progress: prog,
      error: row.error, finished_at: row.finished_at,
      events: events ? listEvents(row.id, { limit: events }) : undefined,
    };
  }

  function phaseState(phaseId, row) {
    const cur = PHASE_IDS.indexOf(row.phase);
    const mine = PHASE_IDS.indexOf(phaseId);
    if (row.status === 'failed' && mine === cur) return 'failed';
    if (mine < cur) return 'done';
    if (mine > cur) return 'pending';
    return row.status === 'awaiting_review' ? 'waiting' : row.status === 'completed' ? 'done' : 'active';
  }

  const defaultEgressDecision = (e) => ({ ...e, decision: 'pending', applied_at: null, applied_by: null });

  /* ------------------------------- create ------------------------------- */

  /**
   * createMigration({ input, actor, ttlSeconds })
   * Validates the target, mints the single-use token, computes the TLS pin
   * the agent will hold ProxyPilot to, and returns the row plus the ONE
   * plaintext copy of the token and the command to paste on the source.
   */
  async function createMigration({ input = {}, actor = null, ttlSeconds = DEFAULT_TTL_SECONDS, ip = null } = {}) {
    const v = validateTarget(input);
    if (v.error) return { error: v.error };
    const spec = v.spec;
    const incusName = `${lxcPrefix}${spec.name}`;

    const clash = db().prepare(`SELECT id, status FROM migrations WHERE target_name = ? AND status NOT IN ('completed','failed','cancelled')`).get(incusName);
    if (clash) return { error: `migration ${clash.id} is already running against ${incusName} (${clash.status}) — cancel it first` };
    const exists = await exec('incus', ['config', 'show', incusName], { timeoutMs: 30000 });
    if (exists.status === 0 && spec.mode === 'whole-machine') return { error: `the guest ${incusName} already exists — a migration never overwrites a guest; pick another name` };

    const minted = mintMigrationToken({ ttlSeconds, now: now() });
    const pin = await tlsPin();
    const base = String(publicBaseUrl?.() || publicBaseUrl || '').replace(/\/+$/, '');
    const ts = nowIso(now());
    // token_expires_at is NOT NULL from migration 909 and an expiry is now
    // optional, so "no expiry" is the empty string — which every reader
    // already treats as absent (Date.parse('') is NaN).
    const info = db().prepare(`
      INSERT INTO migrations (created_at, created_by, updated_at, mode, transport, status, phase, spec_json, target_name, source_label,
                              token_id, token_hash, token_expires_at, tls_pin, checklist_json, bytes_done)
      VALUES (?, ?, ?, ?, ?, 'created', 'inventory', ?, ?, ?, ?, ?, ?, ?, '{}', 0)
    `).run(ts, actor, ts, spec.mode, spec.transport, JSON.stringify(spec), incusName, spec.source_label, minted.token_id, minted.token_hash, minted.expires_at || '', pin);

    const id = Number(info.lastInsertRowid);
    event(id, { kind: 'state', phase: 'inventory', message: `migration created (${spec.mode}, ${spec.transport}) → ${incusName}` });
    try { logAudit(actor, 'MIGRATION_CREATE', 'migration', String(id), { mode: spec.mode, transport: spec.transport, target: incusName }, ip); } catch { /* best effort */ }

    return {
      migration: view(rowById(id)),
      token: minted.token,                 // the only time the plaintext exists
      command: installCommand({ baseUrl: base, token: minted.token }),
      command_steps: installCommandTwoStep({ baseUrl: base, token: minted.token }),
      expires_at: minted.expires_at,
      tls_pin: pin,
      note: `Run the command on the SOURCE host as root. The token is single-use and scoped to this migration; ${minted.expires_at ? `it expires at ${minted.expires_at}, and it ` : 'it does not expire on a clock — it '}dies when the migration finishes and can be revoked at any time (Migrations → Agent tokens, or revoke_migration_token). Nothing is copied until you approve the inventory.`,
    };
  }

  /* ------------------------------ the token ----------------------------- */

  /**
   * Authenticate an agent call. `claimant` is the agent's own run id, so the
   * token cannot be taken over by a second agent, and a NAT'd source keeps
   * working across reconnects.
   */
  function authenticate(presented, { claimant = null, ip = null } = {}) {
    // parseToken, never split('_'): the secret is base64url and may contain
    // an underscore of its own, so a hand-rolled split rejects about half of
    // the tokens we mint.
    const parsed = parseToken(presented);
    if (!parsed) return { error: 'malformed migration token', code: 'bad_token' };
    const row = rowByTokenId(parsed.token_id);
    const v = verifyToken(row, presented, { now: now(), claimant });
    if (v.error) return v;
    if (v.first_use && claimant) {
      db().prepare('UPDATE migrations SET token_claimed_by = ?, token_claimed_at = ?, token_source_ip = ?, updated_at = ? WHERE id = ?')
        .run(claimant, nowIso(now()), ip, nowIso(now()), row.id);
      event(row.id, { kind: 'state', message: `agent claimed the token from ${ip || 'an unknown address'}` });
    }
    db().prepare('UPDATE migrations SET token_last_seen_at = ? WHERE id = ?').run(nowIso(now()), row.id);
    return { row: rowById(row.id), first_use: v.first_use };
  }

  /* ------------------------------ the job ------------------------------- */

  /**
   * What the agent polls. It carries everything the source needs and nothing
   * it does not: no other migration, no host credentials beyond the
   * single-use Incus trust token this migration's transfer needs.
   */
  async function agentJob(row) {
    const spec = parse(row.spec_json, {});
    const approved = !!row.approved_at || spec.auto_transfer === true;
    const job = {
      migration_id: row.id, status: row.status, phase: row.phase, mode: row.mode, transport: row.transport,
      approved, cancelled: row.status === 'cancelled',
      collect_inventory: !row.manifest_at,
      target: { name: row.target_name, type: spec.type, pool: spec.pool, network: spec.network, cpu: spec.cpu, memory_gb: spec.memory_gb, disk_gb: spec.disk_gb, nested: !!spec.nested },
      app: spec.app || null,
      keep_agent: spec.keep_agent === true,
      poll_seconds: row.status === 'awaiting_review' ? 15 : 5,
    };
    if (!approved) return job;

    if (row.transport === 'incus-migrate') {
      const t = await incusTrustToken(row);
      if (t.error) return { ...job, error: t.error, approved: false };
      job.incus = { url: t.url, token: t.token, fingerprint: t.fingerprint, answers: migrateAnswers(row, spec, t) };
    }
    if (row.transport === 'rootfs-tar') {
      job.artifact = { kind: 'rootfs', chunk_bytes: 8 * 1024 * 1024, exclude: TAR_EXCLUDES };
    }
    if (row.transport === 'file-sync') {
      const t = await syncTarget(row, spec);
      if (t.error) return { ...job, error: t.error, approved: false };
      job.sync = t;
    }
    return job;
  }

  /**
   * The answer script for `incus-migrate`. The tool is interactive and its
   * prompt order has changed between releases, so the SERVER owns the answer
   * sequence: a version difference is a one-line change here, not a new agent
   * binary on every source host. The agent pipes these lines to its stdin in
   * order and streams everything it prints back to us.
   */
  function migrateAnswers(row, spec, trust) {
    const vm = spec.type === 'virtual-machine';
    const kind = vm ? '2' : '1';
    const source = vm ? '/dev/sda' : '/';   // the agent substitutes the real root device
    // Answering by PROMPT, not by position. Learned live against Incus 6.0.4
    // (LEARNINGS 183): it asks for the authentication MECHANISM between the
    // fingerprint and the token, so a positional script feeds the token into
    // a menu and the migration dies on "illegal base64 data". The patterns
    // below are the prompt strings of incus-migrate 6.0.x, kept deliberately
    // loose where the wording has drifted between releases.
    const rules = [
      // A source host that runs Incus itself is asked this first. We always
      // target the ProxyPilot host, never the source's own daemon.
      { label: 'local server is the target', when: 'local (incus|lxd) server is the target', send: 'no' },
      { label: 'server URL', when: 'provide (the )?(Incus|LXD) server URL', send: trust.url },
      { label: 'accept the certificate', when: 'ok \\(y/n\\)', send: 'y' },
      { label: 'authentication mechanism', when: 'pick an authentication mechanism', send: '1' },
      { label: 'trust token', when: 'provide the certificate token', send: trust.token, secret: true },
      // Empty accepts the prompt's own default, which is the default project.
      { label: 'project', when: 'project to create the instance in', send: '' },
      { label: 'container or virtual machine', when: 'container \\(1\\) or (a )?virtual[- ]machine \\(2\\)', send: kind },
      { label: 'instance name', when: 'name of the (new )?instance', send: row.target_name },
      // 6.0.4 says "a root filesystem"; older releases say "the root
      // filesystem". Match either, and accept "root fs" too.
      { label: 'root filesystem path', when: 'path to (a|the) root ?(filesystem|fs)', send: '/' },
      { label: 'source disk', when: 'path to a disk, partition, or', send: source },
      { label: 'UEFI boot', when: 'support UEFI booting', send: 'yes' },
      { label: 'UEFI secure boot', when: 'support UEFI Secure Boot', send: 'yes' },
      { label: 'additional mounts', when: 'add additional (filesystem )?(mounts|mount points)', send: 'no' },
      { label: 'extra mount path', when: 'filesystem mount path', send: '', max: 2 },
    ];
    // The overrides menu. Option 4 is "Change instance storage pool or volume
    // size" and option 1 begins the migration, so a pool or a disk size costs
    // one extra trip through the menu. Two rules share the prompt and are
    // matched in order, which is how the sequence is expressed: the first ask
    // gets 4, the next gets 1. Without a pool or a size there is no rule 4 at
    // all and the first ask begins the migration.
    if (spec.pool || spec.disk_gb) {
      rules.push({ label: 'change the storage pool or size', when: 'pick one of the options above', send: '4', max: 1 });
      rules.push({ label: 'storage pool', when: 'provide the storage pool to use', send: spec.pool || '' });
      rules.push({ label: 'change the storage size', when: 'want to change the storage size', send: spec.disk_gb ? 'yes' : 'no' });
      if (spec.disk_gb) rules.push({ label: 'storage size', when: 'specify the storage size', send: `${spec.disk_gb}GiB` });
    }
    rules.push({ label: 'begin the migration', when: 'pick one of the options above', send: '1', max: 2 });

    // The same answers in order: what an operator would type by hand, and
    // what an agent older than these rules still feeds positionally.
    const lines = [trust.url, 'y', '1', trust.token, kind, row.target_name, source, 'no'];
    if (spec.pool || spec.disk_gb) {
      lines.push('4', spec.pool || '', spec.disk_gb ? 'yes' : 'no');
      if (spec.disk_gb) lines.push(`${spec.disk_gb}GiB`);
    }
    lines.push('1');
    return {
      lines,
      rules,
      note: 'Each rule answers one incus-migrate prompt, matched on the prompt text (case-insensitive), in order — two rules may share a pattern to express a sequence (the overrides menu is answered 4 then 1 when a storage pool or size is set). `lines` is the same sequence positionally. The agent substitutes {{ROOT_DEVICE}} / {{ROOTFS}} where it knows better, and fails with the prompt text if incus-migrate asks something no rule covers.',
    };
  }

  /** A single-use Incus trust token for this migration, and where to reach Incus. */
  async function incusTrustToken(row) {
    const addr = await exec('incus', ['config', 'get', 'core.https_address'], { timeoutMs: 20000 });
    const listen = String(addr.stdout || '').trim();
    if (addr.status !== 0) return { error: `could not read Incus config: ${tail(addr.stderr) || `exit ${addr.status}`}` };
    if (!listen) return { error: 'Incus is not listening on the network, so incus-migrate has nothing to connect to. Turn it on from Migrations → Preflight (or enable_incus_listener), which proposes the bridge gateway rather than every interface; by hand it is `incus config set core.https_address <addr>:8443`.' };
    const name = `pp-migrate-${row.id}`;
    const mk = await exec('incus', ['config', 'trust', 'add', '--name', name, '--quiet'], { timeoutMs: 30000 });
    let token = String(mk.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    if (mk.status !== 0 || !token) {
      const legacy = await exec('incus', ['config', 'trust', 'add', name], { timeoutMs: 30000 });
      token = String(legacy.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
      if (legacy.status !== 0 || !token) return { error: `could not mint an Incus trust token: ${tail(mk.stderr) || tail(legacy.stderr) || 'no token printed'}` };
    }
    const fp = await exec('incus', ['info'], { timeoutMs: 20000 });
    const fingerprint = (String(fp.stdout || '').match(/certificate_fingerprint:\s*([0-9a-f]{16,})/i) || [])[1] || null;
    // core.https_address is usually ':8443' — a bare port. Prefix the host,
    // do not REPLACE the colon, or the source is handed https://host8443.
    const url = listen.startsWith('http') ? listen
      : listen.startsWith(':') ? `https://${hostAddressGuess()}${listen}`
        : `https://${listen}`;
    return { url, token, fingerprint, trust_name: name };
  }

  function hostAddressGuess() {
    // `core.https_address` is usually `:8443`; the source needs a reachable
    // host, so fall back to the dashboard's own public hostname.
    try { return new URL(String(publicBaseUrl?.() || publicBaseUrl || '')).hostname || 'localhost'; } catch { return 'localhost'; }
  }

  /**
   * Application mode's transport instructions. The agent never touches the
   * guest: it tars each directory and the database dump to ProxyPilot, which
   * unpacks them through `incus exec`. No sshd, no key, no open port added to
   * a guest that did not ask for one.
   *
   * `since` is set on a second pass so the tar carries only what changed —
   * the final delta sync, without rsync's dependency.
   */
  async function syncTarget(row, spec) {
    const chk = await exec('incus', ['config', 'show', row.target_name], { timeoutMs: 30000 });
    if (chk.status !== 0) return { error: `the target guest ${row.target_name} does not exist yet — approve the transfer and ProxyPilot creates it first` };
    const dirs = spec.app?.dirs || [];
    if (!dirs.length) return { error: 'no application directory was chosen — set app_dirs on the migration (the inventory proposes them)' };
    return {
      dirs, excludes: spec.app?.excludes || [], database: spec.app?.database || 'none',
      chunk_bytes: 8 * 1024 * 1024,
      since: row.approved_at && row.phase === 'cutover' ? row.approved_at : null,
      note: 'Each directory is tarred and PUT to /artifact; ProxyPilot unpacks it into the guest. The database dump travels the same way.',
    };
  }

  /* --------------------------- the Incus listener ------------------------ */

  /**
   * Can a source host reach this Incus at all?
   *
   * `incus-migrate` connects to the Incus API DIRECTLY from the source, so a
   * whole-machine migration of a physical host or a VM needs
   * `core.https_address` set. Incus does not listen on the network by
   * default, and turning that on is an operator decision about exposure —
   * so ProxyPilot reads the state, proposes the NARROWEST address that
   * works, and never flips it on its own.
   */
  async function incusListener() {
    const cfg = await exec('incus', ['config', 'get', 'core.https_address'], { timeoutMs: 20000 });
    if (cfg.status !== 0) return { error: `could not read the Incus config: ${tail(cfg.stderr) || `exit ${cfg.status}`}` };
    const address = String(cfg.stdout || '').trim() || null;
    const bridge = await incusBridge();
    const suggested = bridge.gateway ? `${bridge.gateway}:8443` : null;
    return {
      address, listening: !!address, bridge: bridge.name, bridge_gateway: bridge.gateway, suggested,
      scope: address ? addressScope(address) : null,
      note: address
        ? `Incus is listening on ${address}. A source host must be able to reach that address.`
        : 'Incus is not listening on the network. A whole-machine migration of a physical host or a VM cannot reach it until it is (a container source can still use the rootfs-tar transport, which goes through ProxyPilot).',
    };
  }

  /** The Incus bridge the default profile puts guests on, and its gateway. */
  async function incusBridge() {
    const prof = await exec('incus', ['query', '/1.0/profiles/default'], { timeoutMs: 20000 });
    let name = null;
    try {
      const devices = JSON.parse(prof.stdout || '{}')?.devices || {};
      const nic = Object.values(devices).find((d) => d && d.type === 'nic' && (d.network || d.parent));
      name = nic?.network || nic?.parent || null;
    } catch { name = null; }
    if (!name) return { name: null, gateway: null };
    const addr = await exec('incus', ['network', 'get', name, 'ipv4.address'], { timeoutMs: 20000 });
    const gateway = (String(addr.stdout || '').trim().split('/')[0]) || null;
    return { name, gateway: /^\d+\.\d+\.\d+\.\d+$/.test(gateway || '') ? gateway : null };
  }

  /** How exposed is an address Incus would listen on? */
  function addressScope(address) {
    const a = String(address).trim();
    const host = a.startsWith('[') ? a.slice(1, a.indexOf(']')) : a.split(':').slice(0, -1).join(':') || '';
    if (!host || host === '0.0.0.0' || host === '::' || host === '*') return 'every interface, including any public one';
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 'a private address';
    return 'a specific address (check whether it is public)';
  }

  /**
   * Turn the listener on at an address the operator chose. Refuses a
   * public-facing bind unless it is asked for explicitly: the default is the
   * Incus bridge gateway, which every guest can reach and nothing outside
   * the host can.
   */
  async function enableIncusListener({ address = null, allowPublic = false, actor = null, ip = null } = {}) {
    const state = await incusListener();
    if (state.error) return state;
    const want = String(address || state.suggested || '').trim();
    if (!want) return { error: 'no address to listen on: pass one (host:port), or set up the Incus bridge first' };
    if (!/^(\[[0-9a-fA-F:]+\]|[0-9a-zA-Z.-]*):\d{2,5}$/.test(want)) return { error: `address must be host:port (e.g. ${state.suggested || '10.0.0.1:8443'})` };
    const scope = addressScope(want);
    if (scope.startsWith('every interface') && !allowPublic) {
      return { error: `refused: ${want} listens on ${scope}. A source host on your LAN can use ${state.suggested || 'the bridge gateway'}; pass allow_public: true only if the source really is on the internet, and put the Incus port behind your firewall.` };
    }
    if (state.address === want) return { already: true, ...state };
    const r = await exec('incus', ['config', 'set', 'core.https_address', want], { timeoutMs: 30000 });
    if (r.status !== 0) return { error: `incus config set core.https_address ${want} failed: ${tail(r.stderr) || `exit ${r.status}`}` };
    const after = await incusListener();
    if (after.address !== want) return { error: `Incus did not take the address (it reports ${after.address || 'nothing'})` };
    try { logAudit(actor, 'MIGRATION_INCUS_LISTENER', 'host', 'core.https_address', { address: want, scope, previous: state.address }, ip); } catch { /* best effort */ }
    return { ...after, changed: true, previous: state.address, reverse_with: state.address ? `incus config set core.https_address ${state.address}` : 'incus config unset core.https_address' };
  }

  /** Everything an operator needs before starting a migration. Read-only. */
  async function preflight() {
    const [builds, listener, pin, pools, staging] = await Promise.all([
      agentBinaries(), incusListener(), tlsPin(), listPoolSpace(), stagingSpace(),
    ]);
    const base = String(publicBaseUrl?.() || publicBaseUrl || '');
    const checks = [];
    const add = (id, status, detail, remedy = null) => checks.push({ id, status, detail, remedy });

    const haveBuilds = Object.entries(builds).filter(([, b]) => b?.sha256).map(([a]) => a);
    add('agent_builds', haveBuilds.length ? 'pass' : 'fail',
      haveBuilds.length ? `agent built for ${haveBuilds.join(', ')}` : 'no agent build is present, so a source host has nothing to download',
      haveBuilds.length ? null : 'run scripts/build-migration-agent.sh on this host (install.sh and update.sh do it for you)');
    add('public_url', base ? 'pass' : 'fail', base ? `sources will be told to call ${base}` : 'no public URL is known, so the pasted command would have nowhere to point',
      base ? null : 'set PROXYPILOT_PUBLIC_URL, or record the admin domain in settings');
    add('tls_pin', pin ? 'pass' : 'warn', pin ? `agents will pin ${pin.slice(0, 20)}…` : 'no certificate could be read, so the agent falls back to the system trust store',
      pin ? null : 'fine on a private network; worth fixing before migrating over the internet');
    add('incus_listener', listener.listening ? 'pass' : 'warn',
      listener.listening ? `Incus listens on ${listener.address} (${listener.scope})` : 'Incus does not listen on the network',
      listener.listening ? null : `a container source can still use rootfs-tar; a physical host or a VM needs incus-migrate, which connects directly — enable it on ${listener.suggested || 'the bridge gateway'}`);

    // Room. Not a pass/fail — how much a migration can bring, and where it
    // would land by default. The per-migration verdict comes later, when the
    // inventory says how much is actually coming.
    const dflt = pools.find((p) => p.default);
    add('storage', dflt?.free_bytes != null ? 'pass' : 'warn',
      pools.length
        ? `${pools.map((p) => `${p.name}${p.default ? ' (default)' : ''}: ${p.free_bytes != null ? `${(p.free_bytes / 1024 ** 3).toFixed(0)} GiB free` : 'free space unreadable'}`).join(', ')}; staging on ${staging.path} has ${staging.free_bytes != null ? `${(staging.free_bytes / 1024 ** 3).toFixed(0)} GiB free` : 'unreadable free space'}`
        : 'no Incus storage pool could be read',
      dflt?.free_bytes != null ? null : 'a migration will still run; nothing will check that what is coming fits');

    return {
      at: nowIso(now()), base_url: base, tls_pin: pin, agent_builds: builds, incus: listener, checks,
      storage: { pools, staging, default_pool: dflt?.name || null },
      ready_for: {
        'rootfs-tar': haveBuilds.length > 0 && !!base,
        'file-sync': haveBuilds.length > 0 && !!base,
        'incus-migrate': haveBuilds.length > 0 && !!base && listener.listening,
      },
      summary: { pass: checks.filter((c) => c.status === 'pass').length, warn: checks.filter((c) => c.status === 'warn').length, fail: checks.filter((c) => c.status === 'fail').length },
    };
  }

  /* ------------------------------ capacity ------------------------------- */

  /** The pool a guest lands in when the spec does not name one. */
  async function defaultProfilePool() {
    const r = await exec('incus', ['query', '/1.0/profiles/default'], { timeoutMs: 20000 });
    if (r.status !== 0) return null;
    const prof = parse(r.stdout, null);
    return prof?.devices?.root?.pool || null;
  }

  /**
   * Free space on an Incus storage pool, whatever drives it.
   *
   * `/1.0/storage-pools/<name>/resources` is what `incus storage info` reads,
   * so it answers for zfs, btrfs, lvm and a plain directory alike — no
   * mapping from Incus pool to ZFS pool to guess at.
   */
  async function poolSpace(pool) {
    const name = pool || await defaultProfilePool();
    if (!name) return { pool: null, free_bytes: null, total_bytes: null, error: 'no pool named and the default profile has no root disk' };
    const r = await exec('incus', ['query', `/1.0/storage-pools/${encodeURIComponent(name)}/resources`], { timeoutMs: 30000 });
    if (r.status !== 0) return { pool: name, free_bytes: null, total_bytes: null, error: tail(r.stderr) || `exit ${r.status}` };
    const res = parse(r.stdout, null);
    const total = Number(res?.space?.total);
    const used = Number(res?.space?.used);
    if (!Number.isFinite(total)) return { pool: name, free_bytes: null, total_bytes: null, error: 'the pool reported no space figures' };
    return { pool: name, total_bytes: total, free_bytes: Math.max(0, total - (Number.isFinite(used) ? used : 0)), used_bytes: Number.isFinite(used) ? used : null };
  }

  /** Every Incus pool with its free space, and which one new guests land in. */
  async function listPoolSpace() {
    const [list, dflt] = await Promise.all([
      exec('incus', ['storage', 'list', '--format', 'json'], { timeoutMs: 30000 }),
      defaultProfilePool(),
    ]);
    if (list.status !== 0) return [];
    const pools = parse(list.stdout, []) || [];
    return Promise.all(pools.map(async (p) => {
      const space = await poolSpace(p.name);
      return {
        name: p.name, driver: p.driver || null, default: p.name === dflt,
        free_bytes: space.free_bytes, total_bytes: space.total_bytes, used_bytes: space.used_bytes ?? null,
        error: space.error || null,
      };
    }));
  }

  /** Free space where the transfer is staged — ProxyPilot's own disk. */
  async function stagingSpace() {
    await mkdir(workDir, { recursive: true }).catch(() => {});
    const r = await exec('df', ['-B1', '--output=avail', workDir], { timeoutMs: 20000 });
    if (r.status !== 0) return { path: workDir, free_bytes: null, error: tail(r.stderr) || `exit ${r.status}` };
    // The LAST all-digits token: `df --output=avail` prints a header line and
    // then the number. Nothing numeric means we do not know — which is a
    // warning. Reading it as zero would block every migration on a host whose
    // df said something unexpected.
    const digits = String(r.stdout || '').trim().split(/\s+/).filter((t) => /^\d+$/.test(t));
    if (!digits.length) return { path: workDir, free_bytes: null, error: `could not read a free-space figure from df (${String(r.stdout || '').trim().slice(0, 80) || 'no output'})` };
    return { path: workDir, free_bytes: Number(digits.at(-1)) };
  }

  /**
   * Will this migration fit? Measured, not guessed: what the manifest says is
   * coming against what the target pool and the staging disk actually have.
   * Recorded on the row so the page, the MCP reader and the approval gate all
   * read the same numbers.
   */
  async function measureCapacity(row, { manifest = null, store = true } = {}) {
    const man = manifest || parse(row.manifest_json, null);
    if (!man) return null;
    const spec = parse(row.spec_json, {});
    const needs = capacityNeeds(man, { mode: row.mode, transport: row.transport });
    const [pool, staging] = await Promise.all([poolSpace(spec.pool), stagingSpace()]);
    const verdict = capacityVerdict({
      needs, pool: pool.pool,
      poolFreeBytes: pool.free_bytes, poolTotalBytes: pool.total_bytes,
      stagingFreeBytes: staging.free_bytes, stagingPath: staging.path,
    });
    const capacity = {
      at: nowIso(now()), transport: row.transport, needs,
      pool: { name: pool.pool, requested: spec.pool || null, free_bytes: pool.free_bytes, total_bytes: pool.total_bytes, error: pool.error || null },
      staging: { path: staging.path, free_bytes: staging.free_bytes, error: staging.error || null },
      ...verdict,
    };
    if (store) db().prepare('UPDATE migrations SET capacity_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(capacity), nowIso(now()), row.id);
    return capacity;
  }

  /* ------------------------------ manifest ------------------------------ */

  /** The agent's inventory. Refused outright if it carries a secret value. */
  async function recordManifest(row, raw) {
    const v = validateManifest(raw);
    if (v.error) {
      event(row.id, { kind: 'error', phase: 'inventory', message: v.error });
      return { error: v.error };
    }
    const spec = parse(row.spec_json, {});
    const egress = observedEgress(v.manifest).map(defaultEgressDecision);
    const auto = spec.auto_transfer === true;
    const ts = nowIso(now());
    db().prepare(`UPDATE migrations SET manifest_json = ?, manifest_at = ?, egress_json = ?, status = ?, updated_at = ?,
                  approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, ?) WHERE id = ?`)
      .run(JSON.stringify(v.manifest), ts, JSON.stringify(egress), auto ? 'running' : 'awaiting_review', ts,
        auto ? ts : null, auto ? 'auto_transfer' : null, row.id);
    // Measure the fit now, while the operator is about to read the review:
    // "it will not fit" is worth knowing before the bytes start, not after.
    const capacity = await measureCapacity(rowById(row.id), { manifest: v.manifest }).catch(() => null);
    const sum = manifestSummary(v.manifest);
    event(row.id, { kind: 'state', phase: 'inventory', message: `inventory received: ${sum.os || 'unknown OS'}, ${sum.counts.units} units, ${sum.counts.vhosts} vhosts, ${sum.counts.databases} database engine(s), ${sum.counts.egress} outbound host(s)` });
    if (!auto) event(row.id, { kind: 'state', phase: 'inventory', message: 'waiting for the operator to review the inventory and approve the transfer' });
    return { manifest: v.manifest, summary: sum, capacity, concerns: manifestConcerns(v.manifest, { mode: row.mode, capacity }), auto_approved: auto };
  }

  /* ------------------------------ approval ------------------------------ */

  /**
   * Let the bytes leave the source.
   *
   * The blocking-concern gate lives HERE rather than in each caller, so the
   * dashboard's Approve button and `approve_migration` refuse the same things
   * for the same reasons. Capacity is re-measured first: the inventory may
   * have landed hours ago, and "the pool had room then" is not an answer.
   */
  async function approveTransfer(id, { actor = null, ip = null, override = false } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such migration' };
    if (TERMINAL.includes(row.status)) return { error: `migration ${id} is ${row.status}` };
    if (!row.manifest_at) return { error: 'the inventory has not arrived yet — there is nothing to review' };
    if (row.approved_at) return { error: 'this transfer is already approved' };
    const spec = parse(row.spec_json, {});

    const capacity = await measureCapacity(row).catch(() => null);
    const blocking = manifestConcerns(parse(row.manifest_json, null) || {}, { mode: row.mode, capacity }).filter((c) => c.level === 'block');
    if (blocking.length && override !== true) {
      return {
        error: `refused: ${blocking.map((b) => b.text).join(' ')}`,
        concerns: blocking,
        capacity,
        override_with: 'override: true (approve_migration: override_blocking: true) — only after reading the concern',
      };
    }
    if (blocking.length) event(id, { kind: 'state', message: `approved over ${blocking.length} blocking concern(s) by ${actor || 'operator'}: ${blocking.map((b) => b.id).join(', ')}` });

    // Application mode needs the guest to exist BEFORE anything can be
    // unpacked into it; whole-machine mode creates it by arriving.
    if (row.mode === 'application') {
      const made = await ensureApplicationGuest(row, spec);
      if (made.error) return { error: made.error };
    }
    const ts = nowIso(now());
    db().prepare('UPDATE migrations SET approved_at = ?, approved_by = ?, status = ?, phase = ?, updated_at = ? WHERE id = ?')
      .run(ts, actor, 'running', 'transfer', ts, id);
    event(id, { kind: 'state', phase: 'transfer', message: `transfer approved by ${actor || 'operator'}` });
    try { logAudit(actor, 'MIGRATION_APPROVE', 'migration', String(id), { target: row.target_name }, ip); } catch { /* best effort */ }
    return { migration: view(rowById(id)) };
  }

  /** Create the empty guest an application-mode migration copies into. */
  async function ensureApplicationGuest(row, spec) {
    const existing = await exec('incus', ['config', 'show', row.target_name], { timeoutMs: 30000 });
    if (existing.status === 0) {
      event(row.id, { kind: 'log', message: `guest ${row.target_name} already exists — reusing it` });
      db().prepare('UPDATE migrations SET guest_created = 0 WHERE id = ?').run(row.id);
      return { existed: true };
    }
    const cfg = guestConfig(spec, { prefix: '' });
    const argv = ['launch', spec.app?.image || 'images:debian/13', row.target_name];
    if (spec.pool) argv.push('--storage', spec.pool);
    if (spec.network) argv.push('--network', spec.network);
    for (const [k, v] of Object.entries(cfg.config)) argv.push('--config', `${k}=${v}`);
    if (spec.disk_gb) argv.push('--device', `root,size=${spec.disk_gb}GB`);
    const r = await exec('incus', argv, { timeoutMs: 600000 });
    if (r.status !== 0) return { error: `could not create ${row.target_name}: ${tail(r.stderr) || `exit ${r.status}`}` };
    event(row.id, { kind: 'log', message: `created guest ${row.target_name} (${spec.app?.image})` });
    db().prepare('UPDATE migrations SET guest_created = 1 WHERE id = ?').run(row.id);
    await fenceGuest(row);
    return { created: true };
  }

  /**
   * An imported guest is fenced before it is anything else: default-deny
   * egress and no route.
   *
   * Default-deny is the FIREWALL'S BASELINE, not something to add: every
   * bridge → host flow that is not listed is already denied. So fencing is
   * confirming that this guest has no allow entries, and removing any it
   * inherited from a guest of the same name. (The first version ran
   * `egress deny <name> all`, which asks the CLI to remove an entry that was
   * never there and fails with "no egress entry for container" — loudly, on
   * every clean import. Caught on the first real migration.)
   */
  async function fenceGuest(row) {
    const bare = row.target_name.startsWith(lxcPrefix) ? row.target_name.slice(lxcPrefix.length) : row.target_name;
    const list = await exec('proxypilot', ['--json', 'firewall', 'egress', 'list'], { timeoutMs: 60000 });
    if (list.status !== 0) {
      event(row.id, { kind: 'error', message: `could not read the egress rules to confirm the fence: ${tail(list.stderr) || tail(list.stdout) || `exit ${list.status}`} — check it by hand before the route goes up` });
      return { error: 'fence unverified' };
    }
    const entries = (parse(list.stdout, {})?.entries || []).filter((e) => e && (e.container === bare || e.container === row.target_name));
    const removed = [];
    for (const e of entries) {
      const svc = e.service || (e.port ? `${e.proto || 'tcp'}:${e.port}` : null);
      if (!svc) continue;
      const rm = await exec('proxypilot', ['--json', 'firewall', 'egress', 'deny', bare, svc], { timeoutMs: 60000 });
      if (rm.status !== 0) {
        event(row.id, { kind: 'error', message: `an inherited egress allow (${svc}) could not be removed from ${bare}: ${tail(rm.stderr) || tail(rm.stdout)} — remove it by hand before the route goes up` });
        return { error: 'fence incomplete' };
      }
      removed.push(svc);
    }
    event(row.id, {
      kind: 'state',
      message: removed.length
        ? `guest fenced: default-deny on bridge → host services, no route (${removed.length} inherited allow(s) removed: ${removed.join(', ')})`
        : 'guest fenced: default-deny on bridge → host services (the firewall baseline — this guest has no allow entries), and no route',
    });
    return { fenced: true, removed };
  }

  /* ------------------------------- events ------------------------------- */

  function event(migrationId, { kind = 'log', phase = null, bytes = null, message = null, detail = null } = {}) {
    try {
      db().prepare('INSERT INTO migration_events (migration_id, at, phase, kind, bytes, message, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(Number(migrationId), nowIso(now()), phase, String(kind), bytes == null ? null : Math.max(0, Math.round(Number(bytes))), message == null ? null : String(message).slice(0, 2000), j(detail));
      // Keep the stream bounded: a multi-hour transfer emits a progress line a
      // second, and nobody reads the middle of it.
      db().prepare(`DELETE FROM migration_events WHERE migration_id = ? AND kind = 'log' AND id NOT IN (
                      SELECT id FROM migration_events WHERE migration_id = ? ORDER BY id DESC LIMIT ?)`)
        .run(Number(migrationId), Number(migrationId), EVENT_LIMIT);
    } catch (e) { console.warn('[migration] event write failed:', e?.message || e); }
  }

  function listEvents(migrationId, { limit = 200, sinceId = null, kind = null } = {}) {
    const where = ['migration_id = ?']; const params = [Number(migrationId)];
    if (sinceId != null) { where.push('id > ?'); params.push(Number(sinceId)); }
    if (kind) { where.push('kind = ?'); params.push(String(kind)); }
    const rows = db().prepare(`SELECT * FROM migration_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...params, Math.max(1, Math.min(2000, Number(limit) || 200)));
    return rows.reverse().map((r) => ({ id: r.id, at: r.at, phase: r.phase, kind: r.kind, bytes: r.bytes, message: r.message, detail: parse(r.detail_json) }));
  }

  function progressSamples(migrationId) {
    const rows = db().prepare(`SELECT at, bytes FROM migration_events WHERE migration_id = ? AND kind = 'progress' AND bytes IS NOT NULL ORDER BY id DESC LIMIT 200`).all(Number(migrationId));
    return rows.reverse().map((r) => ({ at: Date.parse(r.at), bytes: r.bytes }));
  }

  /**
   * The agent's progress/phase/log/error stream. A phase never rewinds (a
   * replayed event cannot pull a finished run back to `transfer`).
   */
  function recordEvent(row, { kind = 'log', phase = null, bytes = null, total_bytes = null, message = null, detail = null } = {}) {
    const k = ['progress', 'log', 'error', 'phase', 'state'].includes(String(kind)) ? String(kind) : 'log';
    let nextPhase = row.phase;
    if (phase && canAdvance(row.phase, phase)) nextPhase = String(phase);
    const sets = ['updated_at = ?']; const params = [nowIso(now())];
    if (nextPhase !== row.phase) { sets.push('phase = ?'); params.push(nextPhase); }
    if (bytes != null) { sets.push('bytes_done = ?'); params.push(Math.max(0, Math.round(Number(bytes)))); }
    if (total_bytes != null) { sets.push('bytes_total = ?'); params.push(Math.max(0, Math.round(Number(total_bytes)))); }
    if (k === 'error') { sets.push('error = ?'); params.push(String(message || 'the agent reported an error').slice(0, 1000)); }
    if (row.status === 'created' || (row.status === 'awaiting_review' && nextPhase !== 'inventory')) { sets.push('status = ?'); params.push('running'); }
    db().prepare(`UPDATE migrations SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
    event(row.id, { kind: k, phase: nextPhase, bytes, message, detail });
    return { recorded: true, phase: nextPhase };
  }

  /* ------------------------------- artifact ------------------------------ */

  /**
   * The rootfs tarball for the Proxmox-LXC path, streamed in chunks. The file
   * lands under WORK_DIR/<id>/ and is turned into an image by
   * `importRootfsTar`; nothing is executed from it.
   */
  async function artifactPath(row) {
    const dir = join(workDir, String(row.id));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { dir, path: join(dir, 'rootfs.tar.gz') };
  }

  /**
   * Receive one artifact. `kind` says what it is and what happens next:
   *
   *   rootfs   the whole-machine tarball — kept for importRootfsTar
   *   dir      one application directory — unpacked INTO the guest and deleted
   *   dbdump   a logical dump — restored INSIDE the guest and deleted
   *
   * The file lands under WORK_DIR, which install.sh bind-mounts into the
   * backend container at the same path it has on the host — so the host-side
   * `incus` can read exactly the file the backend just wrote. Nothing is
   * executed from an artifact; a tarball is only ever fed to tar.
   */
  async function receiveArtifact(row, stream, { expectedSha256 = null, kind = 'rootfs', name = null } = {}) {
    const { dir } = await artifactPath(row);
    const safe = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || String(now());
    const path = kind === 'rootfs' ? join(dir, 'rootfs.tar.gz') : join(dir, `${kind}-${safe}.bin`);
    const hash = createHash('sha256');
    let bytes = 0;
    await new Promise((resolve, reject) => {
      const out = createWriteStream(path, { mode: 0o600 });
      stream.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_ARTIFACT_BYTES) { stream.destroy(new Error('artifact exceeds the size limit')); return; }
        hash.update(c);
      });
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    });
    const sha = hash.digest('hex');
    if (expectedSha256 && expectedSha256.toLowerCase() !== sha) {
      await rm(path, { force: true });
      return { error: `the ${kind} artifact did not survive the transfer (sha256 ${sha}, expected ${expectedSha256})` };
    }
    event(row.id, { kind: 'state', phase: 'transfer', bytes, message: `${kind}${name ? ` ${name}` : ''} received (${bytes} bytes, sha256 ${sha.slice(0, 12)}…)` });

    if (kind === 'dir') {
      const r = await unpackIntoGuest(row, path, name);
      await rm(path, { force: true });
      if (r.error) return r;
    }
    if (kind === 'dbdump') {
      const r = await restoreIntoGuest(row, path, name);
      await rm(path, { force: true });
      if (r.error) return r;
    }
    return { path: kind === 'rootfs' ? path : null, bytes, sha256: sha, kind };
  }

  /**
   * tar → the guest, through `incus exec`. The redirect happens in a host
   * shell so the tarball streams from disk rather than through the backend's
   * memory, and tar's own --keep-directory-symlink / -p are left at their
   * defaults: this is a restore of the source's own tree, not an overlay.
   */
  async function unpackIntoGuest(row, tarPath, label) {
    const r = await exec('sh', ['-c', 'incus exec "$1" -- tar -xzf - -C / < "$2"', 'sh', row.target_name, tarPath], { timeoutMs: 4 * 3600 * 1000 });
    if (r.status !== 0) return { error: `could not unpack ${label || 'the directory'} into ${row.target_name}: ${tail(r.stderr) || `exit ${r.status}`}` };
    event(row.id, { kind: 'state', phase: 'transfer', message: `unpacked ${label || 'a directory'} into ${row.target_name}` });
    return { unpacked: true };
  }

  /** The logical dump, restored by the guest's own engine. */
  async function restoreIntoGuest(row, dumpPath, engineAndDb) {
    const [engine, dbName] = String(engineAndDb || '').split(':');
    const g = row.target_name;
    let script;
    if (engine === 'postgres') {
      if (!/^[A-Za-z0-9_]{1,63}$/.test(dbName || '')) return { error: `refused: ${JSON.stringify(dbName)} is not a database name` };
      script = `incus exec "$1" -- sh -c 'command -v pg_restore >/dev/null || { echo "postgresql is not installed in the guest" >&2; exit 90; }; su postgres -c "createdb ${dbName}" 2>/dev/null; su postgres -c "pg_restore --no-owner --no-acl -d ${dbName}"' < "$2"`;
    } else if (engine === 'mysql') {
      script = `incus exec "$1" -- sh -c 'command -v mysql >/dev/null || { echo "mysql is not installed in the guest" >&2; exit 90; }; mysql' < "$2"`;
    } else {
      return { error: `unknown dump engine ${JSON.stringify(engine)}` };
    }
    const r = await exec('sh', ['-c', script, 'sh', g, dumpPath], { timeoutMs: 4 * 3600 * 1000 });
    if (r.status !== 0) return { error: `restoring the ${engine} dump into ${g} failed: ${tail(r.stderr) || `exit ${r.status}`}` };
    event(row.id, { kind: 'state', phase: 'transfer', message: `restored the ${engine} dump${dbName ? ` (${dbName})` : ''} inside ${g}` });
    return { restored: true };
  }

  /**
   * metadata.tar.xz + rootfs.tar.gz → `incus image import` → `incus init`.
   * This is the documented split-image format, which is why the agent can
   * send a plain rootfs tar: ProxyPilot supplies the metadata Incus needs.
   */
  async function importRootfsTar(row) {
    const spec = parse(row.spec_json, {});
    const { dir, path } = await artifactPath(row);
    try { await stat(path); } catch { return { error: 'no rootfs tarball has been uploaded for this migration' }; }
    const man = parse(row.manifest_json, {}) || {};
    const arch = normalizeArch(man.source?.arch) || 'x86_64';
    const alias = `pp-migration-${row.id}`;
    const metaDir = join(dir, 'meta');
    await mkdir(metaDir, { recursive: true, mode: 0o700 });
    const metadata = [
      `architecture: ${arch}`,
      `creation_date: ${Math.floor(now() / 1000)}`,
      'properties:',
      `  description: ProxyPilot migration ${row.id} from ${man.source?.hostname || 'an unknown source'}`,
      `  os: ${man.os?.id || 'unknown'}`,
      `  release: ${man.os?.version_id || 'unknown'}`,
      '',
    ].join('\n');
    await writeFile(join(metaDir, 'metadata.yaml'), metadata, { mode: 0o600 });
    const metaTar = join(dir, 'metadata.tar.xz');
    const t = await exec('tar', ['-cJf', metaTar, '-C', metaDir, 'metadata.yaml'], { timeoutMs: 120000 });
    if (t.status !== 0) return { error: `could not build the image metadata: ${tail(t.stderr)}` };

    event(row.id, { kind: 'state', phase: 'import', message: 'importing the rootfs as an Incus image' });
    const imp = await exec('incus', ['image', 'import', metaTar, path, '--alias', alias], { timeoutMs: 3600000 });
    if (imp.status !== 0) return { error: `incus image import failed: ${tail(imp.stderr) || `exit ${imp.status}`}` };

    const cfg = guestConfig(spec, { prefix: '' });
    const argv = ['init', alias, row.target_name];
    if (spec.pool) argv.push('--storage', spec.pool);
    if (spec.network) argv.push('--network', spec.network);
    for (const [k, v] of Object.entries(cfg.config)) argv.push('--config', `${k}=${v}`);
    if (spec.disk_gb) argv.push('--device', `root,size=${spec.disk_gb}GB`);
    const init = await exec('incus', argv, { timeoutMs: 600000 });
    // The image has served its purpose either way; leaving it behind would
    // quietly consume the pool one migration at a time.
    await exec('incus', ['image', 'delete', alias], { timeoutMs: 120000 });
    if (init.status !== 0) return { error: `incus init failed: ${tail(init.stderr) || `exit ${init.status}`}` };
    await rm(dir, { recursive: true, force: true });

    await fenceGuest(row);
    const ts = nowIso(now());
    db().prepare('UPDATE migrations SET phase = ?, status = ?, updated_at = ?, guest_created = 1 WHERE id = ?').run('post-import', 'ready', ts, row.id);
    event(row.id, { kind: 'state', phase: 'post-import', message: `guest ${row.target_name} created from the imported rootfs, stopped and fenced` });
    return { imported: true, guest: row.target_name };
  }

  function normalizeArch(a) {
    const s = String(a || '').toLowerCase();
    if (['amd64', 'x86_64'].includes(s)) return 'x86_64';
    if (['arm64', 'aarch64'].includes(s)) return 'aarch64';
    return null;
  }

  /* ------------------------------- finish -------------------------------- */

  /** The agent says the transfer is done (or has failed). */
  async function agentFinish(row, { ok = true, message = null, bytes = null } = {}) {
    if (!ok) return fail(row.id, message || 'the agent reported a failure');
    if (bytes != null) db().prepare('UPDATE migrations SET bytes_done = ? WHERE id = ?').run(Math.max(0, Math.round(bytes)), row.id);
    event(row.id, { kind: 'state', phase: 'import', message: message || 'the agent finished the transfer' });
    if (row.transport === 'rootfs-tar') return importRootfsTar(rowById(row.id));
    // incus-migrate lands the guest itself and file-sync has already been
    // unpacked into it; verify it is really there, then fence.
    const chk = await exec('incus', ['config', 'show', row.target_name], { timeoutMs: 30000 });
    if (chk.status !== 0) return fail(row.id, `the transfer reported success but ${row.target_name} does not exist on this host`);
    await fenceGuest(rowById(row.id));
    const ts = nowIso(now());
    // A whole-machine transport lands the guest itself; file-sync unpacked
    // into a guest whose origin ensureApplicationGuest already recorded.
    const madeIt = row.transport === 'file-sync' ? row.guest_created : 1;
    db().prepare('UPDATE migrations SET phase = ?, status = ?, updated_at = ?, guest_created = ? WHERE id = ?').run('post-import', 'ready', ts, madeIt, row.id);
    event(row.id, { kind: 'state', phase: 'post-import', message: `guest ${row.target_name} is present, stopped and fenced — the checklist is open` });
    return { imported: true, guest: row.target_name };
  }

  function fail(id, message) {
    const ts = nowIso(now());
    db().prepare('UPDATE migrations SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?').run('failed', String(message).slice(0, 1000), ts, ts, id);
    event(id, { kind: 'error', message: String(message).slice(0, 1000) });
    return { error: String(message) };
  }

  async function cancelMigration(id, { actor = null, reason = null, ip = null } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such migration' };
    if (TERMINAL.includes(row.status)) return { error: `migration ${id} is already ${row.status}` };
    const ts = nowIso(now());
    db().prepare('UPDATE migrations SET status = ?, finished_at = ?, updated_at = ?, error = ? WHERE id = ?')
      .run('cancelled', ts, ts, reason ? String(reason).slice(0, 500) : null, id);
    event(id, { kind: 'state', message: `cancelled by ${actor || 'operator'}${reason ? `: ${reason}` : ''} — the token stops working immediately` });
    await revokeTrust(row);
    try { logAudit(actor, 'MIGRATION_CANCEL', 'migration', String(id), { target: row.target_name, reason }, ip); } catch { /* best effort */ }
    return { migration: view(rowById(id)), note: 'The guest (if one was created) is left exactly as it is — cancelling never deletes data.' };
  }

  /**
   * Kill one migration's agent token without touching the migration.
   *
   * A token now lives until the migration ends, which is the right default
   * for planned work and the wrong one for a command that got pasted into a
   * chat window. This is the undo: the next call presenting it is refused
   * (code `revoked`), whatever state the migration is in. The migration
   * itself is untouched — cancel it too if the run should stop.
   */
  function revokeToken(id, { actor = null, ip = null } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such migration' };
    if (row.token_revoked_at) return { error: `migration ${id}'s token was already revoked at ${row.token_revoked_at}` };
    const ts = nowIso(now());
    db().prepare('UPDATE migrations SET token_revoked_at = ?, token_revoked_by = ?, updated_at = ? WHERE id = ?')
      .run(ts, actor ? String(actor).slice(0, 120) : null, ts, id);
    event(id, { kind: 'state', message: `agent token revoked by ${actor || 'operator'} — a source host presenting it is refused from now on` });
    try { logAudit(actor, 'MIGRATION_TOKEN_REVOKE', 'migration', String(id), { target: row.target_name, token_id: row.token_id }, ip); } catch { /* best effort */ }
    const after = rowById(id);
    return {
      revoked: true, migration_id: id, token: tokenState(after, { now: now() }),
      note: TERMINAL.includes(row.status)
        ? 'That token was already dead (the migration has finished); this makes it explicit.'
        : 'The migration is untouched — cancel it as well if the run should stop.',
    };
  }

  /**
   * Every agent token and what it is doing, newest first. This is the answer
   * to "what is still out there": one row per migration, because a migration
   * has exactly one token for its whole life.
   */
  function listTokens({ state = null, limit = 200 } = {}) {
    const rows = db().prepare('SELECT * FROM migrations ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, Number(limit) || 200)));
    const out = rows.map((r) => ({
      migration_id: r.id,
      target: r.target_name,
      mode: r.mode,
      transport: r.transport,
      migration_status: r.status,
      created_at: r.created_at,
      source_label: r.source_label,
      ...tokenState(r, { now: now() }),
    })).filter((t) => !state || t.state === String(state));
    const counts = {};
    for (const t of out) counts[t.state] = (counts[t.state] || 0) + 1;
    return { tokens: out, counts, usable: out.filter((t) => t.usable).length };
  }

  /* ------------------------------- cleanup ------------------------------- */

  /**
   * Throw away what a finished migration left behind: the guest it created,
   * the record, or both.
   *
   * Deliberately narrow, because "delete the guest" is the most destructive
   * verb in this feature:
   *
   *   - only a FINISHED migration (cancel a live one first);
   *   - only the guest THIS migration created — a guest that was already
   *     there and got adopted is refused, because the operator's own guest is
   *     not ours to delete;
   *   - a guest with a route or a service row is refused, and points at
   *     `delete_lxc_container`, which knows how to unpublish it;
   *   - a running guest is stopped cleanly first (`force` for a hard stop).
   *
   * The guest is deleted WITHOUT an export by default: a migration guest that
   * failed never ran, and the source it came from is still standing. Pass
   * `export: true` for a tarball in the usual place first.
   */
  async function cleanupMigration(id, {
    deleteGuest = false, removeRecord = false, exportFirst = false, force = false,
    dryRun = false, actor = null, ip = null,
  } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such migration' };
    if (!deleteGuest && !removeRecord) return { error: 'nothing to do: pass delete_guest, remove_record, or both' };
    if (!TERMINAL.includes(row.status) && row.status !== 'ready') {
      return { error: `migration ${id} is ${row.status} — cancel it first (cancel_migration), then clean up` };
    }

    const plan = {
      migration: id, target: row.target_name, status: row.status,
      delete_guest: false, remove_record: !!removeRecord, export: null, guest: null,
    };

    if (deleteGuest) {
      const show = await exec('incus', ['config', 'show', row.target_name], { timeoutMs: 30000 });
      if (show.status !== 0) {
        plan.guest = { present: false };
        if (!removeRecord) return { error: `the guest ${row.target_name} does not exist on this host — nothing to delete` };
      } else {
        if (row.guest_created === 0) {
          return { error: `${row.target_name} was NOT created by this migration — it already existed and was adopted, so ProxyPilot will not delete it. Remove it yourself with delete_lxc_container if that is really what you want.` };
        }
        const bare = row.target_name.startsWith(lxcPrefix) ? row.target_name.slice(lxcPrefix.length) : row.target_name;
        // Fails CLOSED: if the route tables cannot be read, we do not know
        // whether this guest is serving traffic, and that is not a question
        // to guess at before an `incus delete`.
        let bound;
        try {
          bound = db().prepare(`SELECT DISTINCT r.domain FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE s.lxc_container_name IN (?, ?)`)
            .all(row.target_name, bare).map((r) => r.domain);
        } catch (e) {
          return { error: `could not check whether a route points at ${row.target_name} (${e?.message || e}) — refusing to delete a guest that might be serving traffic` };
        }
        if (bound.length) {
          return { error: `${row.target_name} is published at ${bound.join(', ')} — this button will not delete a guest that is serving traffic. Delete the route first, or use delete_lxc_container, which unpublishes as it goes.` };
        }
        const state = await exec('incus', ['list', row.target_name, '--format', 'csv', '-c', 's'], { timeoutMs: 30000 });
        plan.guest = { present: true, status: String(state.stdout || '').trim() || 'unknown', created_by_migration: row.guest_created !== 0 };
        plan.delete_guest = true;
        plan.export = exportFirst ? `${workDir}/exports/${row.target_name}-<timestamp>.tar.gz` : null;
      }
    }

    if (dryRun) return { dry_run: true, would: plan, note: 'Nothing has been touched. Re-run with confirm to apply.' };

    const done = { migration: id, guest_deleted: false, record_removed: false, export: null, warnings: [] };

    if (plan.delete_guest) {
      if (exportFirst) {
        await mkdir(join(workDir, 'exports'), { recursive: true });
        const file = join(workDir, 'exports', `${row.target_name}-${Date.now()}.tar.gz`);
        const ex = await exec('incus', ['export', row.target_name, file, '--instance-only'], { timeoutMs: 60 * 60 * 1000 });
        if (ex.status !== 0) return { error: `nothing was deleted: the export failed (${tail(ex.stderr) || `exit ${ex.status}`})` };
        done.export = file;
      }
      if (/running/i.test(plan.guest?.status || '')) {
        const stop = await exec('incus', ['stop', row.target_name, ...(force ? ['--force'] : [])], { timeoutMs: 180000 });
        if (stop.status !== 0) {
          return { error: `could not stop ${row.target_name} cleanly (${tail(stop.stderr) || 'timed out'}) — pass force: true to stop it hard.${done.export ? ` The export is at ${done.export}.` : ''}` };
        }
      }
      const del = await exec('incus', ['delete', row.target_name], { timeoutMs: 300000 });
      if (del.status !== 0) return { error: `incus delete failed: ${tail(del.stderr) || `exit ${del.status}`}${done.export ? ` The export is at ${done.export}.` : ''}` };
      done.guest_deleted = true;
      try { db().prepare('DELETE FROM lxc_command_allowlists WHERE container_name IN (?, ?)').run(row.target_name, row.target_name.replace(new RegExp(`^${lxcPrefix}`), '')); } catch { /* optional table */ }
      event(id, { kind: 'state', message: `guest ${row.target_name} deleted by ${actor || 'operator'}${done.export ? ` (exported to ${done.export} first)` : ''}` });
    }

    // Anything still on disk from the transfer goes with it either way.
    try { await rm(join(workDir, String(id)), { recursive: true, force: true }); } catch { /* best effort */ }

    if (removeRecord) {
      if (!row.token_revoked_at && !TERMINAL.includes(row.status)) revokeToken(id, { actor, ip });
      await revokeTrust(row);
      db().prepare('DELETE FROM migration_events WHERE migration_id = ?').run(id);
      db().prepare('DELETE FROM migrations WHERE id = ?').run(id);
      done.record_removed = true;
    }

    try {
      logAudit(actor, 'MIGRATION_CLEANUP', 'migration', String(id),
        { target: row.target_name, guest_deleted: done.guest_deleted, record_removed: done.record_removed, export: done.export }, ip);
    } catch { /* best effort */ }

    return {
      ...done,
      note: done.record_removed
        ? `Migration ${id} and its event log are gone${done.guest_deleted ? `, and so is ${row.target_name}` : ''}.`
        : `${row.target_name} is deleted; migration ${id} stays as the record of it.`,
    };
  }

  async function revokeTrust(row) {
    const name = `pp-migrate-${row.id}`;
    const list = await exec('incus', ['config', 'trust', 'list', '--format', 'json'], { timeoutMs: 30000 });
    if (list.status !== 0) return;
    for (const c of parse(list.stdout, []) || []) {
      if (c?.name === name && c?.fingerprint) await exec('incus', ['config', 'trust', 'remove', c.fingerprint], { timeoutMs: 30000 });
    }
  }

  /* ------------------------------ checklist ------------------------------ */

  /**
   * Mark a cutover step. `done: false` un-marks it (an operator who realises
   * the health check was green on the wrong port must be able to say so).
   */
  function setChecklistStep(id, { step, done = true, by = null, note = null } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such migration' };
    if (TERMINAL.includes(row.status) && row.status !== 'completed') return { error: `migration ${id} is ${row.status}` };
    const known = checklistFor(row.mode).find((s) => s.id === step);
    if (!known) return { error: `unknown checklist step ${JSON.stringify(step)} (${checklistFor(row.mode).map((s) => s.id).join(', ')})` };
    const state = parse(row.checklist_json, {}) || {};
    if (done) state[step] = { at: nowIso(now()), by: by || null, note: note ? String(note).slice(0, 500) : null };
    else delete state[step];
    const ts = nowIso(now());
    const complete = checklistComplete(row.mode, state);
    db().prepare(`UPDATE migrations SET checklist_json = ?, updated_at = ?, phase = ?, status = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(state), ts, 'cutover', complete ? 'completed' : 'ready', complete ? ts : null, id);
    event(id, { kind: 'state', phase: 'cutover', message: `${done ? 'completed' : 'reopened'} checklist step ${step}${note ? `: ${note}` : ''}`, detail: { by } });
    if (complete) event(id, { kind: 'state', phase: 'cutover', message: 'every required cutover step is done — migration complete' });
    return { migration: view(rowById(id)), complete };
  }

  /**
   * Record the operator's decision on one observed outbound host.
   *
   * What ProxyPilot's guest fence actually governs is bridge → HOST traffic:
   * `NAMED_SERVICES` in cli/src/core/firewall/render.js is a short, code-owned
   * list of host-side endpoints (pgbouncer on the bridge gateway, and
   * whatever else the platform adds), and everything not listed is denied.
   * It does not govern a guest's access to the internet.
   *
   * So an approval means one of two things, and the row says WHICH:
   *   applied       the destination is one of the firewall's named host
   *                 services, and a real allow was written for this guest.
   *   acknowledged  it is an internet destination — reviewed and recorded,
   *                 with nothing claimed about a fence that does not cover it.
   *
   * (The first version sent "https", then "tcp:443", and the first real
   * approval failed both times with `unknown service … Known: pgbouncer`.
   * Learning what the fence is for was the fix; inventing a vocabulary for
   * it was not.)
   */
  async function decideEgress(id, { host, port = null, decision = 'approve', by = null } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such migration' };
    const rows = parse(row.egress_json, []) || [];
    const idx = rows.findIndex((e) => e.host === String(host) && (port == null || Number(e.port) === Number(port)));
    if (idx < 0) return { error: `${host}${port ? `:${port}` : ''} is not in this migration's observed outbound list` };
    const entry = rows[idx];
    if (decision === 'approve') {
      const bare = row.target_name.startsWith(lxcPrefix) ? row.target_name.slice(lxcPrefix.length) : row.target_name;
      const service = await namedHostService(entry);
      if (service) {
        const r = await exec('proxypilot', ['--json', 'firewall', 'egress', 'allow', bare, service, '--reason', `migration ${row.id}: ${entry.host}`], { timeoutMs: 60000 });
        if (r.status !== 0) return { error: `egress allow ${service} failed: ${tail(r.stderr) || tail(r.stdout) || `exit ${r.status}`}` };
        entry.decision = 'approved'; entry.applied = true; entry.applied_as = service;
      } else {
        entry.decision = 'approved'; entry.applied = false; entry.applied_as = null;
        entry.note = `${entry.host}${entry.port ? `:${entry.port}` : ''} is an internet destination. ProxyPilot's guest fence covers bridge → host services only, so this is recorded as reviewed and nothing was written to the firewall.`;
      }
      entry.applied_at = nowIso(now()); entry.applied_by = by;
    } else {
      entry.decision = 'denied'; entry.applied_at = nowIso(now()); entry.applied_by = by;
    }
    rows[idx] = entry;
    db().prepare('UPDATE migrations SET egress_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rows), nowIso(now()), id);
    event(id, {
      kind: 'state',
      message: `egress ${entry.decision}${entry.applied ? ` and allowed as ${entry.applied_as}` : entry.decision === 'approved' ? ' (reviewed; the guest fence does not govern internet destinations)' : ''}: ${entry.host}${entry.port ? `:${entry.port}` : ''}`,
      detail: { by, applied: !!entry.applied },
    });
    return { egress: rows, entry };
  }

  /**
   * The firewall's own name for this destination, or null when it is not one
   * of the host services the fence governs. The CLI owns the vocabulary and
   * publishes it in `egress list`; nothing is ever invented here.
   */
  async function namedHostService(entry) {
    const list = await exec('proxypilot', ['--json', 'firewall', 'egress', 'list'], { timeoutMs: 60000 });
    const services = parse(list.stdout, {})?.services || {};
    if (entry.service && services[entry.service]) return entry.service;
    for (const [name, def] of Object.entries(services)) {
      if (def && Number(def.port) === Number(entry.port) && (def.proto || 'tcp') === (entry.proto || 'tcp')) return name;
    }
    return null;
  }

  /* ------------------------------- listing ------------------------------- */

  function listMigrations({ status = null, limit = 50 } = {}) {
    const where = []; const params = [];
    if (status) { where.push('status = ?'); params.push(String(status)); }
    const rows = db().prepare(`SELECT * FROM migrations${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, Math.max(1, Math.min(500, Number(limit) || 50)));
    return rows.map((r) => {
      const v = view(r, { manifest: false });
      return { id: v.id, created_at: v.created_at, created_by: v.created_by, updated_at: v.updated_at, mode: v.mode, transport: v.transport, status: v.status, phase: v.phase, target: v.target.incus_name, source_label: v.source_label, progress: v.progress, checklist_progress: v.checklist_progress, error: v.error };
    });
  }

  /* ----------------------------- agent binary ---------------------------- */

  /** The cross-built agents and their hashes, as the bootstrap script needs them. */
  async function agentBinaries() {
    const out = {};
    for (const arch of ARCHES) {
      const path = join(agentDir, `proxypilot-agent-linux-${arch}`);
      try {
        const st = await stat(path);
        const sum = await exec('sha256sum', [path], { timeoutMs: 120000 });
        const sha = (String(sum.stdout || '').trim().split(/\s+/)[0] || '').toLowerCase();
        out[arch] = { path, size_bytes: st.size, sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null };
      } catch { out[arch] = null; }
    }
    return out;
  }

  /** `sha256:<hex>` of the leaf certificate a source host will be shown. */
  async function tlsPin() {
    let url;
    try { url = new URL(String(publicBaseUrl?.() || publicBaseUrl || '')); } catch { return null; }
    if (url.protocol !== 'https:') return null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const sock = tlsConnect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: false, timeout: 8000 }, () => {
          const cert = sock.getPeerCertificate();
          const der = cert?.raw;
          finish(der ? formatPin(createHash('sha256').update(der).digest('hex')) : null);
          sock.destroy();
        });
        sock.on('error', () => finish(null));
        sock.on('timeout', () => { finish(null); sock.destroy(); });
      } catch { finish(null); }
    });
  }

  const tail = (s, n = 400) => String(s || '').trim().slice(-n);

  return {
    createMigration, authenticate, agentJob, recordManifest, approveTransfer, recordEvent, receiveArtifact,
    importRootfsTar, agentFinish, cancelMigration, setChecklistStep, decideEgress, listMigrations, listEvents,
    view, rowById, rowByTokenId, agentBinaries, tlsPin, fenceGuest, preflight, incusListener, enableIncusListener,
    revokeToken, listTokens, cleanupMigration, measureCapacity, poolSpace, listPoolSpace, stagingSpace, defaultProfilePool, CHECKLIST,
  };
}
