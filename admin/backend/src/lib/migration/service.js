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
import { validateManifest, manifestSummary, manifestConcerns, observedEgress, suggestedRoutes, databasePlan } from './manifest.js';
import {
  validateTarget, guestConfig, installCommand, installCommandTwoStep, checklistFor, checklistComplete,
  checklistProgress, transferProgress, PHASES, PHASE_IDS, canAdvance, TERMINAL, CHECKLIST,
} from './plan.js';
import { mintMigrationToken, verifyToken, parseToken, formatPin, DEFAULT_TTL_SECONDS } from './token.js';

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
      token: {
        id: row.token_id, expires_at: row.token_expires_at, claimed: !!row.token_claimed_by,
        claimed_at: row.token_claimed_at, last_seen_at: row.token_last_seen_at, source_ip: row.token_source_ip,
        tls_pin: row.tls_pin,
      },
      manifest: man, manifest_at: row.manifest_at,
      summary: man ? manifestSummary(man) : null,
      concerns: man ? manifestConcerns(man, { mode: row.mode }) : [],
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
    const info = db().prepare(`
      INSERT INTO migrations (created_at, created_by, updated_at, mode, transport, status, phase, spec_json, target_name, source_label,
                              token_id, token_hash, token_expires_at, tls_pin, checklist_json, bytes_done)
      VALUES (?, ?, ?, ?, ?, 'created', 'inventory', ?, ?, ?, ?, ?, ?, ?, '{}', 0)
    `).run(ts, actor, ts, spec.mode, spec.transport, JSON.stringify(spec), incusName, spec.source_label, minted.token_id, minted.token_hash, minted.expires_at, pin);

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
      note: 'Run the command on the SOURCE host as root. The token is single-use, scoped to this migration and expires; nothing is copied until you approve the inventory.',
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
    // a menu and the migration dies on "illegal base64 data".
    const rules = [
      { label: 'server URL', when: 'provide (the )?(Incus|LXD) server URL', send: trust.url },
      { label: 'accept the certificate', when: 'ok \\(y/n\\)', send: 'y' },
      { label: 'authentication mechanism', when: 'pick an authentication mechanism', send: '1' },
      { label: 'trust token', when: 'provide the certificate token', send: trust.token, secret: true },
      { label: 'container or virtual machine', when: 'container \\(1\\) or (a )?virtual[- ]machine \\(2\\)', send: kind },
      { label: 'instance name', when: 'name of the (new )?instance', send: row.target_name },
      { label: 'root filesystem path', when: 'path to the root filesystem', send: '/' },
      { label: 'source disk', when: 'path to a disk, partition, or image file', send: source },
      { label: 'additional mounts', when: 'additional filesystem mounts', send: 'no' },
      // The overrides menu, whose first entry begins the migration.
      { label: 'begin the migration', when: 'pick one of the options above', send: '1', max: 2 },
    ];
    // The same answers in order: what an operator would type by hand, and
    // what an agent older than these rules still feeds positionally.
    const lines = [trust.url, 'y', '1', trust.token, kind, row.target_name, source, 'no', '1'];
    return {
      lines,
      rules,
      note: 'Each rule answers one incus-migrate prompt, matched on the prompt text (case-insensitive). `lines` is the same sequence positionally. The agent substitutes {{ROOT_DEVICE}} / {{ROOTFS}} where it knows better, and fails with the prompt text if incus-migrate asks something no rule covers.',
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
    const [builds, listener, pin] = await Promise.all([agentBinaries(), incusListener(), tlsPin()]);
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

    return {
      at: nowIso(now()), base_url: base, tls_pin: pin, agent_builds: builds, incus: listener, checks,
      ready_for: {
        'rootfs-tar': haveBuilds.length > 0 && !!base,
        'file-sync': haveBuilds.length > 0 && !!base,
        'incus-migrate': haveBuilds.length > 0 && !!base && listener.listening,
      },
      summary: { pass: checks.filter((c) => c.status === 'pass').length, warn: checks.filter((c) => c.status === 'warn').length, fail: checks.filter((c) => c.status === 'fail').length },
    };
  }

  /* ------------------------------ manifest ------------------------------ */

  /** The agent's inventory. Refused outright if it carries a secret value. */
  function recordManifest(row, raw) {
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
    const sum = manifestSummary(v.manifest);
    event(row.id, { kind: 'state', phase: 'inventory', message: `inventory received: ${sum.os || 'unknown OS'}, ${sum.counts.units} units, ${sum.counts.vhosts} vhosts, ${sum.counts.databases} database engine(s), ${sum.counts.egress} outbound host(s)` });
    if (!auto) event(row.id, { kind: 'state', phase: 'inventory', message: 'waiting for the operator to review the inventory and approve the transfer' });
    return { manifest: v.manifest, summary: sum, concerns: manifestConcerns(v.manifest, { mode: row.mode }), auto_approved: auto };
  }

  /* ------------------------------ approval ------------------------------ */

  async function approveTransfer(id, { actor = null, ip = null } = {}) {
    const row = rowById(id);
    if (!row) return { error: 'no such migration' };
    if (TERMINAL.includes(row.status)) return { error: `migration ${id} is ${row.status}` };
    if (!row.manifest_at) return { error: 'the inventory has not arrived yet — there is nothing to review' };
    if (row.approved_at) return { error: 'this transfer is already approved' };
    const spec = parse(row.spec_json, {});

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
    if (existing.status === 0) { event(row.id, { kind: 'log', message: `guest ${row.target_name} already exists — reusing it` }); return { existed: true }; }
    const cfg = guestConfig(spec, { prefix: '' });
    const argv = ['launch', spec.app?.image || 'images:debian/13', row.target_name];
    if (spec.pool) argv.push('--storage', spec.pool);
    if (spec.network) argv.push('--network', spec.network);
    for (const [k, v] of Object.entries(cfg.config)) argv.push('--config', `${k}=${v}`);
    if (spec.disk_gb) argv.push('--device', `root,size=${spec.disk_gb}GB`);
    const r = await exec('incus', argv, { timeoutMs: 600000 });
    if (r.status !== 0) return { error: `could not create ${row.target_name}: ${tail(r.stderr) || `exit ${r.status}`}` };
    event(row.id, { kind: 'log', message: `created guest ${row.target_name} (${spec.app?.image})` });
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
    db().prepare('UPDATE migrations SET phase = ?, status = ?, updated_at = ? WHERE id = ?').run('post-import', 'ready', ts, row.id);
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
    db().prepare('UPDATE migrations SET phase = ?, status = ?, updated_at = ? WHERE id = ?').run('post-import', 'ready', ts, row.id);
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
    view, rowById, rowByTokenId, agentBinaries, tlsPin, fenceGuest, preflight, incusListener, enableIncusListener, CHECKLIST,
  };
}
