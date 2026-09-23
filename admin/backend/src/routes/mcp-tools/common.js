// The toolkit every extended MCP tool family is built on.
//
// routes/mcp.js hands in a `ctx` (its own private helpers — takeLxcSnapshot,
// fetchLxcInstance, verifiedContainerWrite, mock2Modules, the Caddy pipeline,
// the DB, the confirmation store …) and each family's createXHandlers(kit)
// returns { toolName: handler }. Nothing here imports routes/mcp.js, so there
// is no import cycle, and a family can be exercised in a test with a fake ctx.
//
// The cross-cutting contract, enforced by the wrappers rather than remembered
// by each handler:
//
//   kit.mutation(name, opts, fn)  — wraps a writing tool. After fn returns,
//       the SERVER writes the mcp_ledger row (redacted args, outcome, dry_run,
//       confirmation used, snapshot taken), the audit_log entry, and — when
//       the handler named a project — the hash-chained change record. A
//       handler cannot forget the ledger; it can only describe its subject.
//   kit.reader(name, fn)          — wraps a read-only tool: errors become tool
//       errors, nothing is recorded.
//   kit.confirmToken(...)         — the one-time confirmation token: first call
//       issues (after every precondition passed), second call consumes.
//   kit.confirmFlag(args, msg)    — the lighter `confirm: true` gate.
//   kit.dry(args, plan)           — the dry-run short-circuit.
//   kit.flag(name)                — feature flags (policy defaults, app_settings overrides).

import { redactArgs, nowIso } from '../../lib/mcp-ext/logic.js';

export function createToolkit(ctx) {
  const {
    getDb, logAudit, getSetting, setSetting, toolResult, policy, confirmations,
    runHostCapture, LXC_PREFIX,
  } = ctx;

  const ok = (data) => toolResult(data);
  const err = (msg, data = null) => toolResult(data ? { error: msg, ...data } : msg, { isError: true });

  /* ------------------------------ flags ------------------------------ */

  function flag(name) {
    const def = policy.feature_flags?.[name]?.default;
    let v = null;
    try { v = getSetting(`feature_flag:${name}`); } catch { v = null; }
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return def !== false;
  }

  function setFlag(name, value) {
    setSetting(`feature_flag:${name}`, value ? '1' : '0');
  }

  function flagRefusal(name) {
    if (flag(name)) return null;
    // A human-only flag (mcp.platform) is never changed over MCP; say where a person turns it on.
    if (policy.feature_flags?.[name]?.human_only) return `The feature flag ${name} is off on this install, so this tool refuses before doing any work. An administrator turns it on in the dashboard: Platform Setup → the Platform MCP access switch at the top of the Platform section. It cannot be changed over MCP.`;
    return `The feature flag ${name} is off on this install — set_feature_flag({ name: "${name}", enabled: true }) turns it back on.`;
  }

  /* ----------------------------- ledger ------------------------------ */

  function writeLedger(row) {
    try {
      getDb().prepare(`
        INSERT INTO mcp_ledger (ts, token_id, actor, tool, subject_type, subject_id, project_id, args_json, outcome, dry_run, confirmation_used, snapshot, summary, detail_json, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.ts, row.token_id ?? null, row.actor ?? null, row.tool, row.subject_type ?? null,
        row.subject_id == null ? null : String(row.subject_id), row.project_id ?? null,
        JSON.stringify(row.args ?? {}), row.outcome, row.dry_run ? 1 : 0, row.confirmation_used ? 1 : 0,
        row.snapshot ?? null, row.summary ?? null, JSON.stringify(row.detail ?? {}), row.duration_ms ?? null,
      );
    } catch (e) {
      console.warn('[mcp] ledger write failed:', e?.message || e);
    }
  }

  function readLedger({ tool = null, subjectType = null, subjectId = null, projectId = null, since = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (tool) { where.push('tool = ?'); params.push(tool); }
    if (subjectType) { where.push('subject_type = ?'); params.push(subjectType); }
    if (subjectId != null) { where.push('subject_id = ?'); params.push(String(subjectId)); }
    if (projectId != null) { where.push('project_id = ?'); params.push(Number(projectId)); }
    if (since) { where.push('ts >= ?'); params.push(since); }
    const sql = `SELECT * FROM mcp_ledger${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return getDb().prepare(sql).all(...params, Math.max(1, Math.min(1000, Number(limit) || 100))).map((r) => ({
      ...r,
      args: safeJson(r.args_json), detail: safeJson(r.detail_json), args_json: undefined, detail_json: undefined,
      dry_run: !!r.dry_run, confirmation_used: !!r.confirmation_used,
    }));
  }

  function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

  /* ----------------------------- wrappers ---------------------------- */

  /**
   * opts: { subjectType, flag?, audit? (action name), keepArgs? [] }
   * fn(args, auth, req, note) — `note` is the handler's report card:
   *   note.subject_id, note.project_id, note.summary, note.snapshot,
   *   note.detail {…}, note.refused (bool), note.needs_confirmation (bool),
   *   note.confirmation_used (bool), note.project (row, for the change record).
   */
  function mutation(name, opts, fn) {
    const subjectType = opts.subjectType || null;
    return async (args, auth, req) => {
      const note = { subject_type: subjectType, subject_id: null, project_id: null, summary: null, snapshot: null, detail: {}, refused: false, needs_confirmation: false, confirmation_used: false, project: null };
      const t0 = Date.now();
      let result;
      const gate = opts.flag ? flagRefusal(opts.flag) : null;
      if (gate) {
        note.refused = true;
        result = err(gate);
      } else {
        try {
          result = await fn(args || {}, auth, req, note);
        } catch (e) {
          console.error(`[mcp] ${name} failed:`, e?.message || e);
          result = err(`Tool failed: ${e?.message || 'unknown error'}`);
        }
      }
      if (note.ledger === false && !result?.isError) return result;   // a read-only branch of a writing tool
      const dryRun = args?.dry_run === true;
      const outcome = result?.isError
        ? (note.refused ? 'refused' : 'error')
        : note.needs_confirmation ? 'needs_confirmation' : dryRun ? 'dry_run' : 'ok';
      writeLedger({
        ts: nowIso(), token_id: auth?.id ?? null, actor: auth?.created_by ?? null, tool: name,
        subject_type: subjectType, subject_id: note.subject_id, project_id: note.project_id,
        args: redactArgs(args || {}, { keep: opts.keepArgs || [] }), outcome, dry_run: dryRun,
        confirmation_used: note.confirmation_used, snapshot: note.snapshot, summary: note.summary,
        detail: { ...note.detail, ...(result?.isError ? { error: firstText(result).slice(0, 500) } : {}) },
        duration_ms: Date.now() - t0,
      });
      if (outcome === 'ok') {
        try {
          logAudit(auth?.created_by ?? null, opts.audit || `MCP_${name.toUpperCase()}`, subjectType || 'mcp', note.subject_id ?? name,
            { via: 'mcp', token_id: auth?.id ?? null, ...(note.snapshot ? { snapshot: note.snapshot } : {}), ...note.detail }, null);
        } catch (e) { console.warn('[mcp] audit write failed:', e?.message || e); }
        if (note.project && note.summary && ctx.appendProjectChangeRecord) {
          try {
            const rec = await ctx.appendProjectChangeRecord(note.project, auth, `mcp ${name}: ${note.summary}`);
            if (rec && !result.isError) result = attach(result, { change_record: rec });
          } catch (e) { console.warn('[mcp] change record failed:', e?.message || e); }
        }
      }
      return result;
    };
  }

  function reader(name, fn) {
    return async (args, auth, req) => {
      try { return await fn(args || {}, auth, req); } catch (e) {
        console.error(`[mcp] ${name} failed:`, e?.message || e);
        return err(`Tool failed: ${e?.message || 'unknown error'}`);
      }
    };
  }

  function firstText(result) {
    return String(result?.content?.[0]?.text || '');
  }

  /** Add fields to a JSON tool result without re-shaping it. */
  function attach(result, extra) {
    const text = firstText(result);
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object' && !Array.isArray(j)) return toolResult({ ...j, ...extra }, { isError: !!result.isError });
    } catch { /* plain text result */ }
    return result;
  }

  /* ------------------------------ gates ------------------------------ */

  /**
   * The one-time confirmation token. Returns null when the caller presented a
   * valid token (and marks note.confirmation_used) or a tool result to return:
   * the issued token on a first call, or the refusal on a bad token.
   */
  function confirmToken(args, auth, note, { tool, subject, action, preview = {} }) {
    const token = args.confirmation_token;
    if (token != null && token !== '') {
      const c = confirmations.consume(token, { tool, subject, actor: auth?.id });
      if (c.error) { note.refused = true; return err(c.error); }
      note.confirmation_used = true;
      return null;
    }
    const issued = confirmations.issue({ tool, subject, actor: auth?.id });
    note.needs_confirmation = true;
    return ok({
      needs_confirmation: true,
      action,
      ...preview,
      confirmation_token: issued.token,
      expires_in_seconds: issued.expires_in_seconds,
      next: `Show the user exactly what "${action}" will do. On their approval re-call ${tool} with the same arguments plus confirmation_token. The token is single-use and bound to this target.`,
    });
  }

  /** The lighter gate: `confirm: true` after the user agreed in conversation. */
  function confirmFlag(args, note, message) {
    if (args.confirm === true) return null;
    note.refused = true;
    return err(`Confirm with the user, then re-call with confirm: true. ${message}`);
  }

  /** dry_run short-circuit: returns the preview result or null. */
  function dry(args, plan) {
    if (args.dry_run !== true) return null;
    return ok({ dry_run: true, would: plan, note: 'Nothing was changed. Re-call without dry_run to apply.' });
  }

  /* --------------------------- exec helpers -------------------------- */

  /** sh -c <script> inside a guest with argv as positional parameters (no shell re-parse of caller input). */
  function guestSh(container, script, argv = [], opts = {}) {
    const incusName = container.startsWith(LXC_PREFIX) ? container : `${LXC_PREFIX}${container}`;
    return runHostCapture('incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', ...argv], { timeoutMs: 60000, ...opts });
  }

  /** Same, for a Mock2 project container (already a full incus name). */
  function projectSh(incusName, script, argv = [], opts = {}) {
    return runHostCapture('incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', ...argv], { timeoutMs: 60000, ...opts });
  }

  /** sh -c <script> on the host, argv positional. */
  function hostSh(script, argv = [], opts = {}) {
    return runHostCapture('sh', ['-c', script, 'sh', ...argv], { timeoutMs: 60000, ...opts });
  }

  function tail(s, n = 400) { return String(s || '').trim().slice(-n); }

  return {
    ctx, ok, err, flag, setFlag, flagRefusal, writeLedger, readLedger, mutation, reader, attach, firstText,
    confirmToken, confirmFlag, dry, guestSh, projectSh, hostSh, tail, policy,
  };
}
