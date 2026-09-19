// Self-editing: ProxyPilot's own checkout as a guarded project.
//
// The CPR blue/green shape applied to the control plane:
//
//   candidate slot  /var/lib/proxypilot/self/candidate — a clone of the live
//                   checkout on its own branch. Patches land HERE, never in the
//                   live checkout. It lives under /var/lib/proxypilot because
//                   that directory is bind-mounted into the dashboard container,
//                   so the checks below can run on this container's node.
//   checks          run in the candidate (backend tests, syntax, optional
//                   frontend build / shellcheck); results are recorded against
//                   the candidate HEAD they ran on.
//   promote         fast-forward the LIVE checkout to the candidate HEAD (after
//                   recording the previous HEAD as the rollback point and
//                   tagging it), then ask the root update runner for a rebuild —
//                   the same `update.sh --yes --rebuild` the Update button runs.
//   rollback        reset the live checkout to the recorded HEAD, same rebuild.
//
// Every git operation on the LIVE checkout goes through the host pivot as root
// with safe.directory pinned to that one path, and refuses when the checkout
// is dirty, when an update is live, or when the host agent is unreachable —
// the same refusals run_proxypilot_update has. --discard-local never appears.
//
// This family sits on its own permission scope: a key must be minted with
// scope.self_edit (create_scoped_key); the operator's original key does not
// carry it (lib/mcp-ext/logic.js scopeRefusal).

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { intIn, stamp, sha256Hex, validGitRefName } from '../../lib/mcp-ext/logic.js';

export function createSelfEditHandlers(kit) {
  const { ctx, ok, err, mutation, reader, confirmToken, dry, hostSh, tail, policy } = kit;
  const { runHostCapture, takeUploadTicket, selfUpdateInstalled, selfUpdateStart, selfUpdateStatus, SELF_UPDATE_POLICY } = ctx;
  const cfg = policy.self_edit;
  const CAND = cfg.candidate_dir;
  const STATE = cfg.state_file;
  const BRANCH = cfg.candidate_branch;

  /* ------------------------------ state file ------------------------------ */

  async function readState() {
    try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return { candidate: null, checks: null, promotions: [], rollback_points: [] }; }
  }
  async function writeState(s) {
    await mkdir(dirname(STATE), { recursive: true });
    await writeFile(STATE, `${JSON.stringify(s, null, 2)}\n`);
  }

  /* ------------------------------ git helpers ----------------------------- */

  // Host-side git, root, trusting exactly the directory named. Argv only.
  function hgit(dir, argv, opts = {}) {
    return runHostCapture('git', ['-c', `safe.directory=${dir}`, '-c', 'user.email=mcp-self@proxypilot', '-c', 'user.name=ProxyPilot MCP (self-edit)', '-C', dir, ...argv], { timeoutMs: 120000, ...opts });
  }
  async function rev(dir, ref = 'HEAD') {
    const r = await hgit(dir, ['rev-parse', ref]);
    const s = (r.stdout || '').trim();
    return r.status === 0 && /^[0-9a-f]{40}$/.test(s) ? s : null;
  }
  async function dirty(dir) {
    const r = await hgit(dir, ['status', '--porcelain']);
    return (r.stdout || '').split('\n').filter((l) => l.trim() && !/package-lock\.json$/.test(l));
  }
  async function candidateExists() {
    const r = await hostSh('test -d "$1/.git" && echo yes || echo no', [CAND], { timeoutMs: 10000 });
    return /yes/.test(r.stdout || '');
  }

  /** The live checkout facts, or an error string. */
  async function live() {
    const installed = await selfUpdateInstalled({ force: true });
    if (!installed.reachable) return { error: `Host agent unreachable (${installed.error || 'no answer'}) — the self-edit family needs it to read the live checkout and to request rebuilds.` };
    if (!installed.configured || !installed.source_dir) return { error: 'No ProxyPilot git checkout is recorded on this host (run update.sh once by hand).' };
    return { installed, dir: installed.source_dir };
  }

  async function liveGuards({ requireClean = true } = {}) {
    if (SELF_UPDATE_POLICY.enabled !== true) return { error: 'run_proxypilot_update is disabled by self-update-allowlist.json, so promote/rollback (which rebuild through the same runner) are off too.' };
    const l = await live();
    if (l.error) return l;
    const progress = await selfUpdateStatus({ logTailBytes: 0 }).catch(() => null);
    if (progress && ['queued', 'running'].includes(progress.status)) return { error: `An update is ${progress.status} (${progress.id || 'unknown id'}) — wait for it to finish.` };
    if (progress?.pending) return { error: 'An update request is already pending for the runner.' };
    if (requireClean && l.installed.dirty) return { error: `The live checkout has uncommitted changes (${l.installed.dirty_files.slice(0, 5).join(', ')}${l.installed.dirty_count > 5 ? ', …' : ''}). Commit or stash them on the host first — self-edit never discards local work.` };
    return l;
  }

  /** Create or refresh the candidate from the live checkout. */
  async function ensureCandidate(liveDir, { reset = false } = {}) {
    const state = await readState();
    const liveHead = await rev(liveDir);
    if (!liveHead) return { error: 'Could not read the live checkout HEAD' };
    if (!(await candidateExists())) {
      await hostSh('mkdir -p "$(dirname "$1")" && chmod 750 "$(dirname "$1")"', [CAND], { timeoutMs: 10000 });
      const c = await hgit('/', ['clone', '-q', '--no-hardlinks', liveDir, CAND], { timeoutMs: 10 * 60 * 1000 });
      if (c.status !== 0) return { error: `git clone into the candidate slot failed: ${tail(c.stderr)}` };
      const b = await hgit(CAND, ['checkout', '-q', '-B', BRANCH, liveHead]);
      if (b.status !== 0) return { error: `could not create ${BRANCH}: ${tail(b.stderr)}` };
      state.candidate = { base_sha: liveHead, head_sha: liveHead, branch: BRANCH, created_at: new Date().toISOString(), patches: [] };
      state.checks = null;
      await writeState(state);
      return { state, created: true, base: liveHead, head: liveHead };
    }
    const f = await hgit(CAND, ['fetch', '-q', liveDir, `+HEAD:refs/remotes/live/head`], { timeoutMs: 5 * 60 * 1000 });
    if (f.status !== 0) return { error: `could not fetch the live checkout into the candidate: ${tail(f.stderr)}` };
    const head = await rev(CAND);
    const base = state.candidate?.base_sha || null;
    const ahead = base ? Number((await hgit(CAND, ['rev-list', '--count', `${base}..HEAD`])).stdout.trim()) || 0 : 0;
    if (reset || !ahead) {
      // Nothing unpromoted in the candidate (or an explicit reset): rebase the
      // slot onto the live HEAD so the next patch applies against reality.
      const r = await hgit(CAND, ['checkout', '-q', '-B', BRANCH, liveHead]);
      if (r.status !== 0) return { error: `could not reset the candidate: ${tail(r.stderr)}` };
      await hgit(CAND, ['clean', '-fdq', '-e', 'node_modules', '-e', 'dist']);
      state.candidate = { base_sha: liveHead, head_sha: liveHead, branch: BRANCH, created_at: new Date().toISOString(), patches: [] };
      state.checks = null;
      await writeState(state);
      return { state, reset: true, base: liveHead, head: liveHead };
    }
    if (base && base !== liveHead && ahead) {
      return { state, stale: true, base, head, live_head: liveHead, ahead, note: `The live checkout moved (${base.slice(0, 8)} → ${liveHead.slice(0, 8)}) since this candidate was based; ${ahead} unpromoted commit(s) sit on the old base. Promote refuses until it is rebased: apply_self_patch({ reset: true }) discards the candidate's commits and starts over from the live HEAD.` };
    }
    return { state, base, head, ahead };
  }

  /* ------------------------------ local exec ------------------------------ */

  // The checks run in THIS container (node is here; the candidate is on the
  // bind mount). Output is capped and tailed; the exit code is the verdict.
  function runLocal(argv, { cwd, timeoutMs, env = {} }) {
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, CI: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let errOut = ''; let timedOut = false;
      const cap = (s, chunk) => (s.length > 256 * 1024 ? s.slice(-128 * 1024) + chunk : s + chunk);
      child.stdout.on('data', (d) => { out = cap(out, d.toString()); });
      child.stderr.on('data', (d) => { errOut = cap(errOut, d.toString()); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ status: 127, stdout: out, stderr: `${errOut}\n${e.message}`, timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout: out, stderr: errOut, timedOut }); });
    });
  }

  /* --------------------------------- tools -------------------------------- */

  const get_self_status = reader('get_self_status', async () => {
    const l = await live();
    const state = await readState();
    const exists = await candidateExists();
    let candidate = null;
    if (exists) {
      const head = await rev(CAND);
      const base = state.candidate?.base_sha || null;
      const ahead = base ? Number((await hgit(CAND, ['rev-list', '--count', `${base}..HEAD`])).stdout.trim()) || 0 : null;
      const log = await hgit(CAND, ['log', '--oneline', '-n', '10', ...(base ? [`${base}..HEAD`] : [])]);
      candidate = { dir: CAND, branch: BRANCH, base_sha: base, head_sha: head, ahead, dirty: (await dirty(CAND)).length, commits: (log.stdout || '').trim().split('\n').filter(Boolean), created_at: state.candidate?.created_at || null };
    }
    return ok({
      live: l.error ? { error: l.error } : { dir: l.dir, branch: l.installed.branch, sha: l.installed.sha, dirty: l.installed.dirty, dirty_files: l.installed.dirty_files, version: l.installed.checkout_version, remote: l.installed.remote_url },
      candidate: exists ? candidate : null,
      checks: state.checks, last_promotion: state.promotions?.[state.promotions.length - 1] || null, rollback_points: (state.rollback_points || []).slice(-5),
      policy: { required_checks_for_promote: cfg.required_checks_for_promote, checks: Object.keys(cfg.checks) },
      flow: 'apply_self_patch → run_self_checks → promote_self (confirmation token) → poll get_proxypilot_update_status; rollback_self restores the recorded HEAD.',
    });
  });

  const read_self_file = reader('read_self_file', async (args) => {
    const rel = String(args.path || '').replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.startsWith('.git/') || rel === '.git' || /[\u0000]/.test(rel)) return err('path must be a repo-relative file path (never .git)');
    const slot = args.slot === 'live' ? 'live' : 'candidate';
    let dir;
    if (slot === 'live') { const l = await live(); if (l.error) return err(l.error); dir = l.dir; }
    else { if (!(await candidateExists())) { const l = await live(); if (l.error) return err(l.error); const c = await ensureCandidate(l.dir); if (c.error) return err(c.error); } dir = CAND; }
    const r = await hostSh('f="$1/$2"; test -f "$f" || { echo NOFILE >&2; exit 66; }; wc -c < "$f"; sha256sum "$f" | cut -d" " -f1; head -c 1048576 "$f"', [dir, rel], { timeoutMs: 30000, maxCapture: 1200 * 1024 });
    if (r.status === 66) return err(`${rel} does not exist in the ${slot} checkout`);
    if (r.status !== 0) return err(`Could not read ${rel}: ${tail(r.stderr)}`);
    const nl1 = r.stdout.indexOf('\n'); const nl2 = r.stdout.indexOf('\n', nl1 + 1);
    const size = Number(r.stdout.slice(0, nl1)); const sha = r.stdout.slice(nl1 + 1, nl2).trim(); const body = r.stdout.slice(nl2 + 1);
    const lines = body.split('\n');
    const offset = intIn(args.offset, 1, 1e7); const limit = intIn(args.limit, 1, 20000);
    const content = offset ? lines.slice(offset - 1, offset - 1 + (limit || 400)).join('\n') : body;
    return ok({ slot, path: rel, size_bytes: size, sha256: sha, total_lines: body.endsWith('\n') ? lines.length - 1 : lines.length, truncated: size > 1048576, ...(offset ? { offset, limit: limit || 400 } : {}), content });
  });

  const apply_self_patch = mutation('apply_self_patch', { subjectType: 'self', flag: 'mcp.self_edit' }, async (args, auth, req, note) => {
    note.subject_id = 'candidate';
    const l = await live();
    if (l.error) return err(l.error);
    const c = await ensureCandidate(l.dir, { reset: args.reset === true });
    if (c.error) return err(c.error);
    if (c.stale && args.reset !== true) { note.refused = true; return err(c.note); }
    let patch = null;
    if (args.ticket) { try { const t = await takeUploadTicket(args.ticket); patch = t.buf.toString('utf8'); await t.discard(); } catch (e) { return err(e.message); } }
    else if (typeof args.patch === 'string') patch = args.patch;
    if (!patch || !patch.trim()) {
      if (args.reset === true) { note.summary = 'candidate reset to live HEAD'; note.detail = { head: c.head }; return ok({ reset: true, candidate: { base_sha: c.base, head_sha: c.head, dir: CAND } }); }
      return err('patch (a unified diff) or ticket is required');
    }
    if (Buffer.byteLength(patch) > 4 * 1024 * 1024) return err('patch is over 4 MB — split it');
    if (args.sha256 && sha256Hex(Buffer.from(patch)).toLowerCase() !== String(args.sha256).toLowerCase()) return err('sha256 does not match the patch that arrived — resend it');
    const files = [...new Set([...patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)].map((m) => m[1]).filter((f) => f !== '/dev/null'))];
    if (files.some((f) => f.startsWith('.git/') || f.includes('..') || f.startsWith('/'))) return err('The patch touches a path outside the checkout');
    if (args.expected_sha256 && typeof args.expected_sha256 === 'object') {
      for (const [p, want] of Object.entries(args.expected_sha256)) {
        const r = await hostSh('f="$1/$2"; test -f "$f" && sha256sum "$f" | cut -d" " -f1 || echo ABSENT', [CAND, p], { timeoutMs: 15000 });
        const have = (r.stdout || '').trim();
        if (have !== String(want).toLowerCase()) return err(`${p} has changed in the candidate (expected ${want}, found ${have}). Re-read it with read_self_file.`);
      }
    }
    const check = await hgit(CAND, ['apply', '--check', '--3way'], { input: patch });
    if (check.status !== 0) return err(`The patch does not apply to the candidate:\n${tail(check.stderr, 1500)}\nNothing was changed.`);
    const message = String(args.message || `self-edit patch (${files.length} file(s))`).slice(0, 200);
    const plan = { candidate: CAND, base_sha: c.base, head_before: c.head, files, message };
    const d = dry(args, plan); if (d) return d;
    const ap = await hgit(CAND, ['apply', '--3way', '--index'], { input: patch });
    if (ap.status !== 0) { await hgit(CAND, ['checkout', '-q', '--', '.']); await hgit(CAND, ['reset', '-q', '--hard', 'HEAD']); return err(`git apply failed and the candidate was reset:\n${tail(ap.stderr, 1500)}`); }
    const conflicts = await hgit(CAND, ['diff', '--check']);
    if (/conflict/i.test(conflicts.stdout || '')) { await hgit(CAND, ['reset', '-q', '--hard', 'HEAD']); return err('The patch applied only with conflict markers — refused and reset.'); }
    await hgit(CAND, ['add', '-A', '--', ...files]);
    const commit = await hgit(CAND, ['commit', '-q', '-m', message]);
    if (commit.status !== 0) { await hgit(CAND, ['reset', '-q', '--hard', 'HEAD']); return err(`commit failed: ${tail(commit.stderr)}`); }
    const head = await rev(CAND);
    const stat = await hgit(CAND, ['diff', '--stat', `${c.head}..HEAD`]);
    const state = await readState();
    state.candidate = { ...(state.candidate || {}), base_sha: c.base, head_sha: head, branch: BRANCH, patches: [...(state.candidate?.patches || []), { at: new Date().toISOString(), by: auth.created_by, files, sha: head, message }].slice(-50) };
    state.checks = state.checks?.sha === head ? state.checks : null;
    await writeState(state);
    note.summary = `candidate patch: ${message}`;
    note.detail = { files, head, base: c.base };
    return ok({ applied: true, candidate: { dir: CAND, branch: BRANCH, base_sha: c.base, head_sha: head }, files, stat: tail(stat.stdout, 3000), next: 'run_self_checks, then promote_self.' });
  });

  const run_self_checks = mutation('run_self_checks', { subjectType: 'self', flag: 'mcp.self_edit' }, async (args, auth, req, note) => {
    note.subject_id = 'candidate';
    if (!(await candidateExists())) return err('No candidate yet — apply_self_patch creates it');
    const wanted = Array.isArray(args.checks) && args.checks.length ? args.checks.map(String) : cfg.required_checks_for_promote;
    const unknown = wanted.filter((c) => !cfg.checks[c]);
    if (unknown.length) return err(`Unknown check(s): ${unknown.join(', ')}. Known: ${Object.keys(cfg.checks).join(', ')}`);
    const head = await rev(CAND);
    const d = dry(args, { checks: wanted, candidate_head: head }); if (d) return d;
    try { await access(CAND); } catch { return err(`${CAND} is not visible inside the dashboard container — the /var/lib/proxypilot bind mount is missing, so checks cannot run here.`); }
    const results = {};
    for (const name of wanted) {
      const spec = cfg.checks[name];
      const cwd = join(CAND, spec.cwd || '.');
      const t0 = Date.now();
      if (spec.optional_binary) {
        const probe = await runLocal(['sh', '-c', `command -v ${spec.optional_binary}`], { cwd: CAND, timeoutMs: 5000 });
        if (probe.status !== 0) { results[name] = { ok: null, skipped: true, reason: `${spec.optional_binary} is not installed in the dashboard container` }; continue; }
      }
      if (spec.install && args.skip_install !== true) {
        const inst = await runLocal(spec.install, { cwd, timeoutMs: 15 * 60 * 1000 });
        if (inst.status !== 0) { results[name] = { ok: false, stage: 'install', exit_code: inst.status, tail: tail(`${inst.stdout}\n${inst.stderr}`, 3000), duration_ms: Date.now() - t0 }; continue; }
      }
      let argv = spec.argv;
      if (name === 'backend-tests') {
        // Skip the test files that need native modules absent from this image
        // (docs/known-issues.md): they fail identically on main and say nothing
        // about the patch.
        const skip = ['cve-research.test.js', 'cves.test.js', 'incus.test.js', 'webauthn.test.js', 'vpn-mtu.test.js', 'ldap.test.js'];
        const list = await runLocal(['sh', '-c', `ls src/__tests__/*.test.js | grep -v -E '(${skip.join('|')})$'`], { cwd, timeoutMs: 10000 });
        argv = ['node', '--test', ...list.stdout.trim().split('\n').filter(Boolean)];
      } else if (name === 'backend-syntax') {
        const changed = await hgit(CAND, ['diff', '--name-only', `${(await readState()).candidate?.base_sha || head}..HEAD`, '--', 'admin/backend']);
        const js = (changed.stdout || '').split('\n').filter((f) => /\.(m?js)$/.test(f)).map((f) => join(CAND, f));
        if (!js.length) { results[name] = { ok: true, skipped: true, reason: 'no backend JS files changed' }; continue; }
        argv = ['sh', '-c', js.map((f) => `node --check '${f.replace(/'/g, "'\\''")}'`).join(' && ')];
      }
      const r = await runLocal(argv, { cwd, timeoutMs: (spec.timeout_seconds || 600) * 1000 });
      const summary = (r.stdout.match(/# pass \d+[\s\S]*?# fail \d+/) || [null])[0];
      results[name] = { ok: r.status === 0 && !r.timedOut, exit_code: r.status, timed_out: r.timedOut, duration_ms: Date.now() - t0, ...(summary ? { summary: summary.replace(/\n/g, ' ') } : {}), tail: tail(`${r.stdout}\n${r.stderr}`, 4000) };
    }
    const allOk = wanted.every((n) => results[n].ok === true || results[n].skipped === true);
    const requiredOk = cfg.required_checks_for_promote.every((n) => results[n]?.ok === true);
    const state = await readState();
    state.checks = { sha: head, at: new Date().toISOString(), by: auth.created_by, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ok: v.ok, skipped: !!v.skipped, exit_code: v.exit_code ?? null, summary: v.summary || v.reason || null }])), ok: requiredOk };
    await writeState(state);
    note.summary = `self checks on ${head.slice(0, 8)}: ${allOk ? 'green' : 'RED'}`;
    note.detail = { head, ok: allOk, results: state.checks.results };
    return ok({ candidate_head: head, ok: allOk, promote_ready: requiredOk, results, next: requiredOk ? 'promote_self (issues a confirmation token).' : 'Fix the candidate with apply_self_patch and re-run.' });
  });

  const promote_self = mutation('promote_self', { subjectType: 'self', flag: 'mcp.self_edit' }, async (args, auth, req, note) => {
    note.subject_id = 'live';
    const l = await liveGuards();
    if (l.error) { note.refused = true; return err(l.error); }
    if (!(await candidateExists())) return err('No candidate to promote');
    const state = await readState();
    const head = await rev(CAND);
    const liveHead = await rev(l.dir);
    const base = state.candidate?.base_sha || null;
    if (!base || base !== liveHead) { note.refused = true; return err(`The candidate is based on ${base ? base.slice(0, 8) : 'nothing'} but the live checkout is at ${liveHead?.slice(0, 8)}. apply_self_patch({ reset: true }) and re-apply the change on the current HEAD.`); }
    const ahead = Number((await hgit(CAND, ['rev-list', '--count', `${base}..HEAD`])).stdout.trim()) || 0;
    if (!ahead) return err('The candidate has no unpromoted commits');
    if ((await dirty(CAND)).length) return err('The candidate has uncommitted changes — apply_self_patch commits, so something else touched it; reset it.');
    if (!state.checks || state.checks.sha !== head || !state.checks.ok) { note.refused = true; return err(`The required checks (${cfg.required_checks_for_promote.join(', ')}) have not passed on candidate HEAD ${head.slice(0, 8)} — run_self_checks first.`); }
    const log = await hgit(CAND, ['log', '--oneline', `${base}..HEAD`]);
    const plan = { live_dir: l.dir, live_branch: l.installed.branch, from_sha: liveHead, to_sha: head, commits: (log.stdout || '').trim().split('\n').filter(Boolean), checks: state.checks, then: 'update.sh --yes --rebuild through the root runner (API unreachable ~1–2 min)', rollback_point: `git tag pp-rollback-<timestamp> at ${liveHead.slice(0, 8)}` };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'promote_self', subject: head, action: `promote candidate ${head.slice(0, 8)} (${ahead} commit(s)) onto the live ProxyPilot checkout and rebuild`, preview: plan });
    if (gate) return gate;
    const tag = `pp-rollback-${stamp()}`;
    const t = await hgit(l.dir, ['tag', tag, liveHead]);
    if (t.status !== 0) return err(`Could not tag the rollback point: ${tail(t.stderr)}`);
    const f = await hgit(l.dir, ['fetch', '-q', CAND, BRANCH], { timeoutMs: 5 * 60 * 1000 });
    if (f.status !== 0) return err(`fetch from the candidate failed: ${tail(f.stderr)}`);
    const m = await hgit(l.dir, ['merge', '--ff-only', 'FETCH_HEAD']);
    if (m.status !== 0) { await hgit(l.dir, ['merge', '--abort']).catch(() => null); return err(`Fast-forward failed (${tail(m.stderr || m.stdout)}); the live checkout is unchanged, tag ${tag} marks it.`); }
    note.snapshot = tag;
    let started;
    try { started = await selfUpdateStart({ requestedBy: `mcp-self:${auth.created_by}`, rebuild: true }); } catch (e) {
      // Undo the fast-forward so the live checkout never sits ahead of what runs.
      await hgit(l.dir, ['reset', '-q', '--hard', liveHead]);
      return err(`The rebuild request was refused (${e.code || 'error'}: ${e.message}); the live checkout was reset to ${liveHead.slice(0, 8)}.`);
    }
    state.promotions = [...(state.promotions || []), { at: new Date().toISOString(), by: auth.created_by, from_sha: liveHead, to_sha: head, tag, update_id: started.id }].slice(-50);
    state.rollback_points = [...(state.rollback_points || []), { tag, sha: liveHead, at: new Date().toISOString() }].slice(-20);
    state.candidate = { ...state.candidate, base_sha: head, head_sha: head, patches: [] };
    await writeState(state);
    note.summary = `promoted ${liveHead.slice(0, 8)} → ${head.slice(0, 8)} (update ${started.id})`;
    note.detail = { from: liveHead, to: head, tag, update_id: started.id };
    return ok({ promoted: true, from_sha: liveHead, to_sha: head, rollback_tag: tag, update: started, next: `poll get_proxypilot_update_status({ id: "${started.id}" }); if the rebuild fails, rollback_self restores ${liveHead.slice(0, 8)} and rebuilds again.` });
  });

  const rollback_self = mutation('rollback_self', { subjectType: 'self', flag: 'mcp.self_edit' }, async (args, auth, req, note) => {
    note.subject_id = 'live';
    const l = await liveGuards();
    if (l.error) { note.refused = true; return err(l.error); }
    const state = await readState();
    const points = state.rollback_points || [];
    let target = null;
    if (args.to) {
      const ref = validGitRefName(String(args.to)) || (/^[0-9a-f]{7,40}$/.test(String(args.to)) ? String(args.to) : null);
      if (!ref) return err('to must be a rollback tag or commit sha');
      target = await rev(l.dir, ref);
      if (!target) return err(`${ref} does not resolve in the live checkout`);
      if (!points.some((p) => p.sha === target) && args.allow_any_ref !== true) return err(`${ref} is not a recorded rollback point (get_self_status lists them) — pass allow_any_ref: true to reset to it anyway`);
    } else {
      const last = points[points.length - 1];
      if (!last) return err('No rollback point recorded (promote_self records one)');
      target = last.sha;
    }
    const liveHead = await rev(l.dir);
    if (liveHead === target) return ok({ applied: false, note: `The live checkout is already at ${target.slice(0, 8)}.` });
    const log = await hgit(l.dir, ['log', '--oneline', `${target}..HEAD`]);
    const plan = { live_dir: l.dir, from_sha: liveHead, to_sha: target, drops: (log.stdout || '').trim().split('\n').filter(Boolean), then: 'update.sh --yes --rebuild through the root runner', safety: `the current HEAD is tagged pp-rollback-<timestamp> first, so this rollback is itself reversible` };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'rollback_self', subject: target, action: `reset the live ProxyPilot checkout from ${liveHead.slice(0, 8)} to ${target.slice(0, 8)} and rebuild`, preview: plan });
    if (gate) return gate;
    const tag = `pp-rollback-${stamp()}`;
    await hgit(l.dir, ['tag', tag, liveHead]);
    const r = await hgit(l.dir, ['reset', '-q', '--hard', target]);
    if (r.status !== 0) return err(`git reset failed: ${tail(r.stderr)}`);
    note.snapshot = tag;
    let started;
    try { started = await selfUpdateStart({ requestedBy: `mcp-self-rollback:${auth.created_by}`, rebuild: true }); } catch (e) {
      await hgit(l.dir, ['reset', '-q', '--hard', liveHead]);
      return err(`The rebuild request was refused (${e.code || 'error'}: ${e.message}); the live checkout was put back at ${liveHead.slice(0, 8)}.`);
    }
    state.rollback_points = [...points, { tag, sha: liveHead, at: new Date().toISOString(), kind: 'pre-rollback' }].slice(-20);
    state.promotions = [...(state.promotions || []), { at: new Date().toISOString(), by: auth.created_by, from_sha: liveHead, to_sha: target, tag, update_id: started.id, rollback: true }].slice(-50);
    await writeState(state);
    note.summary = `rolled back ${liveHead.slice(0, 8)} → ${target.slice(0, 8)} (update ${started.id})`;
    note.detail = { from: liveHead, to: target, tag, update_id: started.id };
    return ok({ rolled_back: true, from_sha: liveHead, to_sha: target, undo_tag: tag, update: started, next: `poll get_proxypilot_update_status({ id: "${started.id}" }).` });
  });

  return { get_self_status, read_self_file, apply_self_patch, run_self_checks, promote_self, rollback_self };
}
