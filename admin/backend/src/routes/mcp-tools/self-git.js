// Prepare a reviewed remote commit without changing the live tree or executing
// the remote's updater. Promotion still uses the existing pinned-build gate.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createSelfGitHandlers(kit) {
  const { ctx, mutation, ok, err, dry, policy, confirmToken } = kit;
  const cfg = policy.self_edit;
  let preparing = false;
  async function git(dir, argv) {
    const result = await ctx.runHostCapture('git', ['-c', `safe.directory=${dir}`, '-C', dir, ...argv], { timeoutMs: 300000 });
    if (result.status !== 0) throw new Error(`Git ${argv[0]} failed; no promotion was requested`);
    return String(result.stdout || '').trim();
  }
  async function clean(dir) {
    if (await git(dir, ['status', '--porcelain'])) throw new Error('Checkout has uncommitted changes; preserve them before staging remote source');
  }
  return {
    prepare_self_from_git: mutation('prepare_self_from_git', { subjectType: 'self', flag: 'mcp.self_edit' }, async (args, auth, req, note) => {
      if (!/^[0-9a-f]{40}$/.test(args.sha || '') || !/^[0-9a-f]{40}$/.test(args.expected_live_sha || '')) return err('sha and expected_live_sha must be full lowercase commit SHAs');
      if (preparing) return err('A remote candidate is already being prepared');
      preparing = true;
      try {
        const live = await ctx.selfUpdateInstalled({ force: true });
        if (!live.reachable || !live.configured || !live.source_dir) return err('The configured live Git checkout is unavailable; use get_self_status for the exact host state');
        const progress = await ctx.selfUpdateStatus({ logTailBytes: 0 });
        if (progress.pending || ['queued', 'running'].includes(progress.status)) return err('An update is already pending or running');
        const base = await git(live.source_dir, ['rev-parse', 'HEAD']);
        if (base !== args.expected_live_sha) return err('The live checkout changed; read get_self_status and review the new base');
        await clean(live.source_dir);
        // No caller URL, credential, branch shell fragment, or alternate updater.
        const remote = await git(live.source_dir, ['remote', 'get-url', 'origin']);
        let url;
        try { url = new URL(remote); } catch { return err('Live origin must be a configured HTTPS Git remote'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return err('Live origin must be HTTPS without embedded credentials');
        const preview = { live_sha: base, candidate_sha: args.sha, remote: url.href, changes_live: false, next: 'run_self_checks then promote_self; the existing pinned updater gate still applies' };
        note.subject_id = 'candidate';
        const d = dry(args, preview); if (d) return d;
        if (args.confirm !== true) { note.refused = true; return err('Review the candidate SHA and re-call with confirm: true'); }
        let state;
        try { state = JSON.parse(await readFile(cfg.state_file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; state = { promotions: [], rollback_points: [] }; }
        let exists = true;
        try { await git(cfg.candidate_dir, ['rev-parse', '--git-dir']); } catch { exists = false; }
        if (!exists) {
          await mkdir(dirname(cfg.candidate_dir), { recursive: true });
          await git('/', ['clone', '--no-hardlinks', live.source_dir, cfg.candidate_dir]);
        }
        await clean(cfg.candidate_dir);
        const previous = await git(cfg.candidate_dir, ['rev-parse', 'HEAD']);
        // Keep both unpromoted work and the old candidate state before staging.
        const backupRef = `refs/proxypilot/candidates/${randomUUID()}`;
        await git(cfg.candidate_dir, ['update-ref', backupRef, previous]);
        await git(cfg.candidate_dir, ['fetch', '--no-tags', '--', remote, args.sha]);
        const fetched = await git(cfg.candidate_dir, ['rev-parse', 'FETCH_HEAD^{commit}']);
        if (fetched !== args.sha) throw new Error('Remote did not return the requested commit');
        await git(cfg.candidate_dir, ['fetch', '--no-tags', '--', live.source_dir, base]);
        // Refuse divergent source. Existing fast-forward promotion remains the
        // authority, and no unrelated-history or force-merge path is introduced.
        let sameTreeAlignment = false;
        try { await git(cfg.candidate_dir, ['merge-base', '--is-ancestor', base, fetched]); }
        catch {
          const currentTree = await git(cfg.candidate_dir, ['rev-parse', `${base}^{tree}`]);
          const remoteTree = await git(cfg.candidate_dir, ['rev-parse', `${fetched}^{tree}`]);
          if (currentTree !== remoteTree || !/^[0-9a-f]{40}$/.test(currentTree)) throw new Error('Remote history diverges and its source tree differs; review and reconcile source first');
          sameTreeAlignment = true;
        }
        if (await git(live.source_dir, ['rev-parse', 'HEAD']) !== base) throw new Error('Live changed during preparation; candidate was not switched');
        await clean(live.source_dir);
        await git(cfg.candidate_dir, ['checkout', '-B', cfg.candidate_branch, fetched]);
        if (await git(cfg.candidate_dir, ['rev-parse', 'HEAD']) !== fetched) throw new Error('Candidate postcondition failed');
        state.candidate_history = [...(state.candidate_history || []), { at: new Date().toISOString(), ref: backupRef, sha: previous, candidate: state.candidate || null }].slice(-50);
        state.candidate = { base_sha: base, head_sha: fetched, branch: cfg.candidate_branch, created_at: new Date().toISOString(), patches: [], source: 'origin', remote_sha: fetched, same_tree_alignment: sameTreeAlignment };
        state.checks = null;
        await mkdir(dirname(cfg.state_file), { recursive: true });
        const tmp = `${cfg.state_file}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await rename(tmp, cfg.state_file);
        note.summary = `prepared remote candidate ${fetched}`;
        note.detail = { base_sha: base, head_sha: fetched, preserved_candidate_ref: backupRef };
        return ok({ prepared: true, ...preview, preserved_candidate_ref: backupRef, checks_invalidated: true, same_tree_alignment: sameTreeAlignment, next: sameTreeAlignment ? 'run_self_checks then adopt_self_git_commit; source trees match but commit histories differ' : preview.next });
      } finally { preparing = false; }
    }),
    adopt_self_git_commit: mutation('adopt_self_git_commit', { subjectType: 'self', flag: 'mcp.self_edit' }, async (args, auth, req, note) => {
      if (preparing) return err('A self Git operation is already running');
      preparing = true;
      try {
        const state = JSON.parse(await readFile(cfg.state_file, 'utf8'));
        const sha = state.candidate?.head_sha, base = state.candidate?.base_sha;
        if (!state.candidate?.same_tree_alignment || !/^[0-9a-f]{40}$/.test(sha || '') || !/^[0-9a-f]{40}$/.test(base || '')) return err('First prepare an exact remote commit with an identical source tree');
        if (args.sha !== sha || args.expected_live_sha !== base) return err('Candidate or live identity changed; review get_self_status');
        if (!state.checks?.ok || state.checks.sha !== sha || !cfg.required_checks_for_promote.every(n => state.checks.results?.[n]?.ok === true)) return err('Required checks must pass on this exact remote commit');
        const live = await ctx.selfUpdateInstalled({ force: true });
        if (!live.reachable || !live.configured || !live.source_dir || ctx.SELF_UPDATE_POLICY?.enabled !== true) return err('Pinned self updates are unavailable');
        const progress = await ctx.selfUpdateStatus({ logTailBytes: 0 });
        if (progress.pending || ['queued', 'running'].includes(progress.status)) return err('An update is pending or running');
        await clean(live.source_dir); await clean(cfg.candidate_dir);
        if (await git(live.source_dir, ['rev-parse', 'HEAD']) !== base || await git(cfg.candidate_dir, ['rev-parse', 'HEAD']) !== sha) return err('Live or candidate changed');
        const tree = await git(live.source_dir, ['rev-parse', 'HEAD^{tree}']);
        if (!/^[0-9a-f]{40}$/.test(tree) || tree !== await git(cfg.candidate_dir, ['rev-parse', 'HEAD^{tree}'])) return err('Source trees differ; identity adoption cannot change files');
        const preview = { from_sha: base, to_sha: sha, tree_sha: tree, changes_files: false, then: `pinned rebuild of ${sha}` };
        note.subject_id = 'live';
        const d = dry(args, preview); if (d) return d;
        const gate = confirmToken(args, auth, note, { tool: 'adopt_self_git_commit', subject: `${base}:${sha}`, action: 'align identical ProxyPilot source with the reviewed remote commit and rebuild', preview });
        if (gate) return gate;
        await git(live.source_dir, ['fetch', '--no-tags', '--', cfg.candidate_dir, sha]);
        const tag = `pp-rollback-identity-${randomUUID()}`;
        await git(live.source_dir, ['tag', tag, base]);
        await clean(live.source_dir);
        // Atomic compare-and-swap of identity only: identical index and worktree.
        await git(live.source_dir, ['update-ref', 'HEAD', sha, base]);
        let update;
        try { update = await ctx.selfUpdateStart({ requestedBy: `mcp-self:${auth.created_by}`, buildCurrentSha: sha }); }
        catch (e) { await git(live.source_dir, ['update-ref', 'HEAD', base, sha]); throw e; }
        state.promotions = [...(state.promotions || []), { at: new Date().toISOString(), by: auth.created_by, from_sha: base, to_sha: sha, tag, update_id: update.id, same_tree_alignment: true }].slice(-50);
        state.rollback_points = [...(state.rollback_points || []), { tag, sha: base, at: new Date().toISOString() }].slice(-20);
        state.candidate = { ...state.candidate, base_sha: sha, same_tree_alignment: false };
        const tmp = `${cfg.state_file}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, cfg.state_file);
        note.snapshot = tag; note.detail = preview; note.summary = 'adopted identical remote Git identity with pinned rebuild';
        return ok({ adopted: true, ...preview, rollback_tag: tag, update, next: 'poll get_proxypilot_update_status and verify running build SHA' });
      } finally { preparing = false; }
    }),
  };
}
