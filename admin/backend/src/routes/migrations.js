// Migrations — move a running web application from another server, VM or
// container onto a ProxyPilot-managed Incus guest.
//
// Two routers, two audiences:
//
//   migrationAgentRouter   /api/migrations/agent/:token/…   NO session. The
//       source host holds one single-use, scoped, expiring token and nothing
//       else. It fetches the bootstrap script and the binary, posts its
//       inventory, streams progress, uploads the rootfs tarball, finishes.
//
//   migrationRouter        /api/migrations/…                admin session,
//       sudo on every mutation. Create, review the inventory, approve the
//       transfer, work the cutover checklist, decide egress, cancel.
//
// The operator-facing side is thin over lib/migration/service.js so the MCP
// `migration` family and the dashboard cannot drift.

import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { migrationService } from '../lib/migration/index.js';
import { installCommand } from '../lib/migration/plan.js';


const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error('[migrations]', e?.stack || e?.message || e); if (!res.headersSent) res.status(500).json({ error: e?.message || 'migration request failed' }); }
};

const publicBase = (req) => {
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  let proto = fwd || req.protocol || 'https';
  const host = req.get('host') || '';
  if (proto === 'http' && !/^(localhost|127\.|\[::1\])/i.test(host)) proto = 'https';
  return `${proto}://${host}`;
};

/* ======================== the agent-facing router ======================== */

export const migrationAgentRouter = Router();

/**
 * Authenticate an agent request from the path token. `claimant` is the
 * agent's own run id (X-Migration-Run), so the token binds to one agent run
 * rather than to an IP that NAT may change mid-transfer.
 */
function agentAuth(req, res) {
  const svc = migrationService();
  const token = String(req.params.token || '');
  const claimant = String(req.get('x-migration-run') || '').slice(0, 64) || null;
  const a = svc.authenticate(token, { claimant, ip: req.ip });
  if (a.error) { res.status(a.code === 'bad_token' ? 401 : 403).json({ error: a.error, code: a.code }); return null; }
  return { svc, row: a.row, token };
}

/**
 * The bootstrap script. Served over TLS with the system trust store (the
 * only unpinned hop there can be), it bakes in the token, the URL, the TLS
 * pin every later call is held to, and the per-arch sha256 — and refuses to
 * run a binary whose hash does not match.
 */
migrationAgentRouter.get('/:token/install.sh', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const { svc, row, token } = a;
  const bins = await svc.agentBinaries();
  const base = publicBase(req);
  const have = Object.entries(bins).filter(([, b]) => b?.sha256);
  res.type('text/x-shellscript').send(bootstrapScript({
    base, token, migrationId: row.id, pin: row.tls_pin,
    sums: Object.fromEntries(have.map(([arch, b]) => [arch, b.sha256])),
    keepAgent: (() => { try { return JSON.parse(row.spec_json).keep_agent === true; } catch { return false; } })(),
  }));
}));

migrationAgentRouter.get('/:token/binary/:arch', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const arch = String(req.params.arch || '');
  const bins = await a.svc.agentBinaries();
  const bin = bins[arch];
  if (!bin) return res.status(404).json({ error: `no ${arch} agent build is present on this host — run scripts/build-migration-agent.sh (install.sh and update.sh do it for you)` });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(bin.size_bytes));
  res.setHeader('X-Content-SHA256', bin.sha256 || '');
  createReadStream(bin.path).pipe(res);
}));

migrationAgentRouter.get('/:token/job', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const job = await a.svc.agentJob(a.row);
  res.json(job);
}));

migrationAgentRouter.post('/:token/inventory', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const r = await a.svc.recordManifest(a.row, req.body);
  if (r.error) return res.status(422).json({ error: r.error });
  res.json({ accepted: true, auto_approved: r.auto_approved, concerns: r.concerns, summary: r.summary, capacity: r.capacity ?? null });
}));

const EventBody = z.object({
  kind: z.enum(['progress', 'log', 'error', 'phase', 'state']).optional(),
  phase: z.string().max(32).optional(),
  bytes: z.number().nonnegative().optional(),
  total_bytes: z.number().nonnegative().optional(),
  message: z.string().max(4000).optional(),
  detail: z.record(z.any()).optional(),
});

migrationAgentRouter.post('/:token/event', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const body = EventBody.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid event' });
  res.json(a.svc.recordEvent(a.row, body.data));
}));

/**
 * An artifact, streamed: the rootfs tarball (whole-machine on a nested LXC),
 * one application directory, or a database dump. Nothing is ever executed
 * from one — a tarball is fed to tar, a dump to the guest's own engine.
 */
migrationAgentRouter.put('/:token/artifact', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const kind = ['rootfs', 'dir', 'dbdump'].includes(String(req.query.kind || 'rootfs')) ? String(req.query.kind || 'rootfs') : null;
  if (!kind) return res.status(400).json({ error: 'kind must be rootfs, dir or dbdump' });
  const allowed = a.row.transport === 'rootfs-tar' ? ['rootfs'] : a.row.transport === 'file-sync' ? ['dir', 'dbdump'] : [];
  if (!allowed.includes(kind)) return res.status(409).json({ error: `this migration transports with ${a.row.transport}; it accepts no ${kind} upload` });
  const expected = String(req.get('x-content-sha256') || '').toLowerCase() || null;
  const r = await a.svc.receiveArtifact(a.row, req, {
    expectedSha256: expected && /^[0-9a-f]{64}$/.test(expected) ? expected : null,
    kind, name: req.query.name ? String(req.query.name).slice(0, 128) : null,
  });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json({ received: true, bytes: r.bytes, sha256: r.sha256, kind: r.kind });
}));

/**
 * The agent asks to carry the transfer over a different transport — the
 * source has no incus-migrate, and the rootfs can go as a tarball instead.
 * The service decides (container target, transfer phase, tarball fits on
 * the staging disk) and answers with the job for the new transport.
 */
const TransportBody = z.object({
  transport: z.enum(['incus-migrate', 'rootfs-tar', 'file-sync']),
  reason: z.string().max(500).optional(),
});

migrationAgentRouter.post('/:token/transport', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const body = TransportBody.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid transport request' });
  const r = await a.svc.switchTransport(a.row, { transport: body.data.transport, reason: body.data.reason || null });
  if (r.error) return res.status(409).json({ error: r.error, concerns: r.concerns, capacity: r.capacity });
  res.json(r);
}));

migrationAgentRouter.post('/:token/finish', wrap(async (req, res) => {
  const a = agentAuth(req, res); if (!a) return;
  const ok = req.body?.ok !== false;
  const r = await a.svc.agentFinish(a.row, { ok, message: req.body?.message ? String(req.body.message).slice(0, 1000) : null, bytes: Number.isFinite(Number(req.body?.bytes)) ? Number(req.body.bytes) : null });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json({ ...r, remove_self: true });
}));

/* ====================== the operator-facing router ======================= */

export const migrationRouter = Router();
migrationRouter.use(requireAdmin);

const CreateBody = z.object({
  mode: z.enum(['whole-machine', 'application']),
  name: z.string().min(1).max(63),
  type: z.enum(['container', 'virtual-machine']).optional(),
  transport: z.enum(['incus-migrate', 'rootfs-tar', 'file-sync']).optional(),
  source_kind: z.string().max(32).optional(),
  source_label: z.string().max(200).optional(),
  cpu: z.number().int().optional(),
  memory_gb: z.number().optional(),
  disk_gb: z.number().int().optional(),
  pool: z.string().max(64).nullish(),
  network: z.string().max(64).nullish(),
  nested: z.boolean().optional(),
  image: z.string().max(128).optional(),
  app_dirs: z.array(z.string().max(256)).max(64).optional(),
  excludes: z.array(z.string().max(200)).max(128).optional(),
  database: z.enum(['none', 'postgres', 'mysql', 'sqlite']).optional(),
  service_name: z.string().max(128).optional(),
  auto_transfer: z.boolean().optional(),
  keep_agent: z.boolean().optional(),
  install_tools: z.boolean().optional(),
  freeze: z.enum(['stop', 'read-only', 'none']).optional(),
  ttl_seconds: z.number().int().min(300).max(86400).optional(),
}).strict();

migrationRouter.get('/', wrap(async (req, res) => {
  const svc = migrationService();
  res.json({
    migrations: svc.listMigrations({ status: req.query.status ? String(req.query.status) : null, limit: Number(req.query.limit) || 50 }),
    agent_builds: await svc.agentBinaries(),
  });
}));

migrationRouter.post('/', requireSudo, wrap(async (req, res) => {
  const body = CreateBody.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: `${body.error.issues[0]?.path?.join('.') || 'body'}: ${body.error.issues[0]?.message}` });
  const { ttl_seconds, ...input } = body.data;
  const r = await migrationService().createMigration({ input, actor: req.user?.id || null, ttlSeconds: ttl_seconds, ip: req.ip });
  if (r.error) return res.status(422).json({ error: r.error });
  res.status(201).json(r);
}));

migrationRouter.get('/preflight', wrap(async (req, res) => {
  res.json(await migrationService().preflight());
}));

/**
 * Turn the Incus network listener on, at an address the operator chose.
 * incus-migrate connects to Incus DIRECTLY from the source host, so a
 * whole-machine migration of a physical host or a VM needs this; the default
 * is the Incus bridge gateway, which guests can reach and the internet
 * cannot, and a bind on every interface is refused without allow_public.
 */
migrationRouter.post('/incus-listener', requireSudo, wrap(async (req, res) => {
  const body = z.object({ address: z.string().max(64).optional(), allow_public: z.boolean().optional() }).strict().safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid body' });
  const r = await migrationService().enableIncusListener({ address: body.data.address || null, allowPublic: body.data.allow_public === true, actor: req.user?.id || null, ip: req.ip });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json(r);
}));

/** Every agent token and what it is doing. Read-only; no secrets in it. */
migrationRouter.get('/tokens', wrap(async (req, res) => {
  res.json(migrationService().listTokens({ state: req.query.state ? String(req.query.state) : null }));
}));

migrationRouter.get('/:id', wrap(async (req, res) => {
  const svc = migrationService();
  const row = svc.rowById(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such migration' });
  res.json({ migration: svc.view(row, { events: Number(req.query.events) || 200 }), install_command: installCommand({ baseUrl: publicBase(req), token: `${row.token_id} (the secret is shown once, at creation)` }) });
}));

migrationRouter.get('/:id/events', wrap(async (req, res) => {
  const svc = migrationService();
  const row = svc.rowById(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such migration' });
  const events = svc.listEvents(row.id, { limit: Number(req.query.limit) || 200, sinceId: req.query.since != null ? Number(req.query.since) : null, kind: req.query.kind ? String(req.query.kind) : null });
  res.json({ events, last_id: events.length ? events[events.length - 1].id : (Number(req.query.since) || 0), status: row.status, phase: row.phase });
}));

migrationRouter.post('/:id/approve', requireSudo, wrap(async (req, res) => {
  const r = await migrationService().approveTransfer(req.params.id, {
    actor: req.user?.id || null, ip: req.ip, override: req.body?.override === true,
  });
  // A refusal carries the concerns and the capacity numbers it was judged on,
  // so the dialog can show what is wrong rather than just that something is.
  if (r.error) return res.status(422).json({ error: r.error, concerns: r.concerns ?? null, capacity: r.capacity ?? null });
  res.json(r);
}));

migrationRouter.post('/:id/cancel', requireSudo, wrap(async (req, res) => {
  const r = await migrationService().cancelMigration(req.params.id, { actor: req.user?.id || null, reason: req.body?.reason ? String(req.body.reason) : null, ip: req.ip });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json(r);
}));

/** Kill one migration's token without touching the migration. */
migrationRouter.post('/:id/token/revoke', requireSudo, wrap(async (req, res) => {
  const r = migrationService().revokeToken(req.params.id, { actor: req.user?.id || null, ip: req.ip });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json(r);
}));

const CleanupBody = z.object({
  delete_guest: z.boolean().optional(),
  remove_record: z.boolean().optional(),
  export: z.boolean().optional(),
  force: z.boolean().optional(),
  dry_run: z.boolean().optional(),
}).strict();

/**
 * Throw away what a finished migration left behind. The dry run is the
 * default answer to the dialog's "what will this do?" — the UI calls it with
 * dry_run first and shows the plan before the operator confirms.
 */
migrationRouter.post('/:id/cleanup', requireSudo, wrap(async (req, res) => {
  const body = CleanupBody.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid body' });
  const r = await migrationService().cleanupMigration(req.params.id, {
    deleteGuest: body.data.delete_guest === true,
    removeRecord: body.data.remove_record === true,
    exportFirst: body.data.export === true,
    force: body.data.force === true,
    dryRun: body.data.dry_run === true,
    actor: req.user?.id || null, ip: req.ip,
  });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json(r);
}));

const ChecklistBody = z.object({ step: z.string().min(1).max(64), done: z.boolean().optional(), note: z.string().max(500).optional() }).strict();

migrationRouter.post('/:id/checklist', requireSudo, wrap(async (req, res) => {
  const body = ChecklistBody.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid body' });
  const r = migrationService().setChecklistStep(req.params.id, { step: body.data.step, done: body.data.done !== false, by: req.user?.username || req.user?.id || null, note: body.data.note || null });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json(r);
}));

const EgressBody = z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535).nullish(), decision: z.enum(['approve', 'deny']) }).strict();

migrationRouter.post('/:id/egress', requireSudo, wrap(async (req, res) => {
  const body = EgressBody.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid body' });
  const r = await migrationService().decideEgress(req.params.id, { ...body.data, by: req.user?.username || req.user?.id || null });
  if (r.error) return res.status(422).json({ error: r.error });
  res.json(r);
}));

/* ---------------------------- bootstrap script --------------------------- */

/**
 * The script the operator pipes into sh. It is deliberately small and
 * readable: an operator pasting a command onto their production web server
 * is entitled to understand what it does in one screen.
 */
export function bootstrapScript({ base, token, migrationId, pin, sums = {}, keepAgent = false }) {
  const arches = Object.entries(sums).map(([arch, sha]) => `  ${arch}) SHA="${sha}" ;;`).join('\n');
  return `#!/bin/sh
# ProxyPilot migration agent — migration ${migrationId}
#
# What this does, in order:
#   1. downloads the ProxyPilot migration agent for this machine's CPU
#   2. verifies its sha256 against the hash baked into THIS script
#   3. runs it as root against one migration, with TLS pinned to the
#      certificate fingerprint below
#
# It copies nothing until you approve the inventory in ProxyPilot, and the
# token below is single-use, scoped to migration ${migrationId}, and expires.
set -eu

URL="${base}"
TOKEN="${token}"
PIN="${pin || ''}"
KEEP="${keepAgent ? '1' : '0'}"

[ "$(id -u)" = "0" ] || { echo "proxypilot-migrate: run me as root (sudo sh …)" >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "proxypilot-migrate: unsupported CPU $(uname -m) (amd64 and arm64 only)" >&2; exit 1 ;;
esac

case "$ARCH" in
${arches || '  *) SHA="" ;;'}
  *) SHA="" ;;
esac
[ -n "$SHA" ] || { echo "proxypilot-migrate: ProxyPilot has no $ARCH agent build — run scripts/build-migration-agent.sh on the ProxyPilot host" >&2; exit 1; }

BIN="$(mktemp /tmp/proxypilot-migrate.XXXXXX)"
trap '[ "$KEEP" = "1" ] || rm -f "$BIN"' EXIT INT TERM

echo "proxypilot-migrate: downloading the $ARCH agent…"
curl -fsSL -o "$BIN" "$URL/api/migrations/agent/$TOKEN/binary/$ARCH"

GOT="$(sha256sum "$BIN" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$BIN" | cut -d' ' -f1)"
[ "$GOT" = "$SHA" ] || { echo "proxypilot-migrate: REFUSED — the downloaded agent hashed $GOT, expected $SHA" >&2; exit 1; }
chmod 0700 "$BIN"

# The agent runs DETACHED from this terminal. A transfer is hours of work
# on a machine you reached over SSH, and the first real one died at 15 GiB
# when that session dropped: SIGHUP took the agent with it. A transient
# systemd unit survives the session (and shows in journalctl); a host
# without systemd gets setsid + nohup. PROXYPILOT_MIGRATE_FOREGROUND=1 keeps
# it in this terminal, for a debugging session that wants the output here.
# Either way the agent removes the binary itself when it ends (unless it
# was asked to keep it), so the trap above is released once it is running.
NAME="proxypilot-migrate-${migrationId}-$(date +%s)"
LOG="/var/log/$NAME.log"
echo "proxypilot-migrate: starting migration ${migrationId}"
if [ "\${PROXYPILOT_MIGRATE_FOREGROUND:-0}" = "1" ]; then
  exec "$BIN" migrate --url "$URL" --token "$TOKEN" --pin "$PIN"${keepAgent ? ' --keep' : ''}
fi
if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemd-run --quiet --collect --unit "$NAME" --description "ProxyPilot migration ${migrationId}" \
    "$BIN" migrate --url "$URL" --token "$TOKEN" --pin "$PIN"${keepAgent ? ' --keep' : ''}
  trap - EXIT INT TERM
  echo "proxypilot-migrate: running in the background as systemd unit $NAME — this session can be closed."
  echo "proxypilot-migrate: follow it in ProxyPilot (Migrations → #${migrationId} → Log) or here: journalctl -u $NAME -f"
else
  setsid nohup "$BIN" migrate --url "$URL" --token "$TOKEN" --pin "$PIN"${keepAgent ? ' --keep' : ''} >"$LOG" 2>&1 </dev/null &
  trap - EXIT INT TERM
  echo "proxypilot-migrate: running in the background (pid $!) — this session can be closed."
  echo "proxypilot-migrate: follow it in ProxyPilot (Migrations → #${migrationId} → Log) or here: tail -f $LOG"
fi
`;
}
