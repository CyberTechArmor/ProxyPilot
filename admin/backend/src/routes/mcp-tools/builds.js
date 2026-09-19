// Builds and the Mock2 stages over MCP.
//
// This family reopens the lane the first MCP surface closed on purpose: it can
// START builds (start_project_build, approve_design, run_checklist) and so it
// SPENDS the project's configured model budget. Every spending verb is behind
// the mcp.builds feature flag and a confirm: true, and says so in its result.
//
// The stage artefacts (mockup, inventory, rules, checklist, handoff, work
// file, releases registry) are files in the project checkout under state/,
// written through the same verified write + commit path the file tools use,
// so they are hashed, read back and committed like any other edit.

import {
  resolveBuildMode, parseChecklist, recordChecklistItem, intIn, sha256Hex,
} from '../../lib/mcp-ext/logic.js';

const PATHS = {
  mockup: 'state/mockups/current.html',
  inventory: 'state/inventory.json',
  rules: 'state/rules.md',
  checklist: 'state/production-checklist.md',
  handoff: 'state/handoff.md',
  work: 'state/work.md',
};

export function createBuildHandlers(kit) {
  const { ctx, ok, err, mutation, reader, confirmFlag, dry, projectSh, tail } = kit;
  const {
    mock2Modules, projectContainerName, requireActiveProject, liveBuildGuard, commitProjectPaths,
    verifiedContainerWrite, readProjectText, M2_APP_DIR, projectUrl,
  } = ctx;

  async function extra() {
    const [audit, concept, questions, quotas, cycleEvents, screenPlanLogic, auditLogic, rulesView, rulesPack, cycleLogic, mock2Db, runner, conceptLogic] = await Promise.all([
      import('../../mock2/audit.js'), import('../../mock2/concept.js'), import('../../mock2/questions.js'), import('../../mock2/quotas.js'),
      import('../../mock2/cycle-events.js'), import('../../mock2/screen-plan-logic.js'), import('../../mock2/audit-logic.js'),
      import('../../mock2/rules-view-logic.js'), import('../../mock2/rules-pack-logic.js'), import('../../mock2/cycle-logic.js'),
      import('../../mock2/db.js'), import('../../mock2/runner.js'), import('../../mock2/concept-logic.js'),
    ]);
    return { audit, concept, questions, quotas, cycleEvents, screenPlanLogic, auditLogic, rulesView, rulesPack, cycleLogic, mock2Db, runner, conceptLogic };
  }

  function mcpUser(auth) {
    // startBuild / answerAuditQuestion take a user row; an MCP key acts as the
    // admin who minted it (same stance as append_change_record).
    return { id: auth.created_by || 'mcp', role: 'admin', username: `mcp:${auth.name || auth.id}` };
  }

  async function project(args) {
    const m = await mock2Modules();
    const { project: p, error } = requireActiveProject(m, args);
    if (error) return { error };
    return { m, project: p, incusName: projectContainerName(m, p) };
  }

  /** Read one state file. { content, sha256, exists } */
  async function readState(incusName, rel) {
    const r = await readProjectText(incusName, rel);
    if (r.error && r.absent) return { exists: false, content: '', sha256: null };
    if (r.error) return { error: r.error };
    return { exists: true, content: r.content, sha256: r.sha256, size: r.size, total_lines: r.total_lines };
  }

  /** Verified write + commit of one state file with expected_sha256 support. */
  async function writeState({ incusName, rel, content, args, note, message, keepOld = true }) {
    const cur = await readState(incusName, rel);
    if (cur.error) return { error: cur.error };
    if (args.expected_sha256 && cur.sha256 && String(args.expected_sha256).toLowerCase() !== cur.sha256) {
      return { error: `${rel} has changed since you read it (expected ${args.expected_sha256}, found ${cur.sha256}). Re-read it and rebuild your change.` };
    }
    if (args.expected_sha256 && !cur.exists) return { error: `${rel} does not exist, so expected_sha256 cannot match.` };
    const w = await verifiedContainerWrite(incusName, `${M2_APP_DIR}/${rel}`, content, { keepOld: keepOld && cur.exists, expectedSha: cur.sha256 || null, label: rel });
    if (w.error) return { error: w.error };
    const git = await commitProjectPaths(incusName, [rel], message);
    note.detail = { ...note.detail, path: rel, bytes: w.bytes, sha256: w.sha256 };
    return { written: true, path: rel, bytes: w.bytes, sha256: w.sha256, total_lines: w.total_lines, previous_sha256: cur.sha256, ...git };
  }

  /* -------------------------------- builds ------------------------------- */

  const start_project_build = mutation('start_project_build', { subjectType: 'mock2_project', flag: 'mcp.builds' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id;
    const task = String(args.task || '').trim();
    if (!task) return err('task is required — the instruction the build runs');
    const mode = resolveBuildMode({ size: args.size, mode: args.mode });
    if (mode.error) return err(mode.error);
    const x = await extra();
    const model = args.model != null && args.model !== '' ? String(args.model) : null;
    if (model && !/^[a-z0-9][a-z0-9.-]{2,80}$/i.test(model)) return err('model must be a model id, e.g. claude-opus-5');
    const guard = liveBuildGuard(p.m, p.project);
    const plan = { project_id: p.project.id, name: p.project.name, mode: mode.mode, size: mode.size || null, model: model || 'project default (connector slot / provider preference)', spends: 'the project\'s configured model budget', design_approved: !!p.project.design_approved_at, ...(guard ? { blocked_by: guard } : {}) };
    const d = dry(args, plan); if (d) return d;
    if (guard) return err(guard);
    const gate = confirmFlag(args, note, `Start a ${mode.mode} build on ${p.project.name}: "${task.slice(0, 120)}"${model ? ` with ${model}` : ''}. This spends the project's model budget.`); if (gate) return gate;
    let result;
    try {
      result = await x.audit.startBuild({ project: p.project, instruction: task, user: mcpUser(auth), actingAsAdmin: 1, buildMode: mode.mode, escalate: !!model, escalateModel: model, origin: 'operator' });
    } catch (e) { return err(`Could not start the build: ${e?.message || e}`); }
    if (result.status === 'error') { note.refused = true; return err(result.error); }
    if (result.status === 'refused') { note.refused = true; return err(`Refused by the pre-build gate: ${result.error}`); }
    const cycle = result.cycle ? x.cycleLogic.publicCycleShape(result.cycle) : null;
    note.summary = `started ${mode.mode} build: ${task.slice(0, 80)}`;
    note.detail = { mode: mode.mode, model, cycle_id: cycle?.id || null, status: result.status };
    return ok({ started: true, status: result.status, ...plan, build: cycle, ...(result.status === 'queued' ? { note: 'Queued behind the running build — list_builds shows the queue position.' } : {}), next: `Poll get_build({ project_id: ${p.project.id}, build_id: ${cycle?.id ?? 'null'} }); stop it with interrupt_project_build.` });
  });

  const list_builds = reader('list_builds', async (args) => {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return err('Project not found');
    const x = await extra();
    const limit = intIn(args.limit, 1, 200) || 25;
    const cycles = m.cycles.listCyclesForProject(p.id, { limit }).map((c) => ({ ...x.cycleLogic.publicCycleShape(c), feedback: x.cycleEvents.getCycleFeedback(c.id) }));
    const queue = m.queue.listBuildQueue(p.id).map((r, i) => ({ ...m.queue.publicQueueShape(r), position: r.status === 'queued' ? i + 1 : null }));
    return ok({ project_id: p.id, name: p.name, lifecycle: p.lifecycle, running: cycles.filter((c) => ['queued', 'estimating', 'running'].includes(c.status)).length, builds: cycles, queue, queued: queue.filter((q) => q.status === 'queued').length });
  });

  const get_build = reader('get_build', async (args) => {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return err('Project not found');
    const x = await extra();
    const cycle = args.build_id != null ? m.cycles.getCycle(Number(args.build_id)) : m.cycles.latestCycle(p.id);
    if (!cycle || cycle.project_id !== p.id) return err('Build not found on this project');
    const queue = m.queue.listBuildQueue(p.id);
    const queuedAhead = queue.filter((r) => r.status === 'queued').findIndex((r) => r.id === cycle.queue_id);
    const req = cycle.request_id ? m.requests.getRequest(cycle.request_id) : null;
    return ok({
      project_id: p.id, build: x.cycleLogic.publicCycleShape(cycle), job: x.runner.getCycleJobStatus(cycle.id),
      request: req ? m.requests.publicRequestShape(req) : null, feedback: x.cycleEvents.getCycleFeedback(cycle.id),
      queue_position: queuedAhead >= 0 ? queuedAhead + 1 : null, open_questions: x.questions.listQuestionsForCycle(cycle.id, { status: 'open' }).map(x.auditLogic.publicQuestionShape),
      url: projectUrl(p, m.domains),
    });
  });

  /* -------------------------- mockup / design ---------------------------- */

  const get_mockup = reader('get_mockup', async (args) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    const cur = await readState(p.incusName, PATHS.mockup);
    if (cur.error) return err(cur.error);
    const max = intIn(args.max_bytes, 1024, 2 * 1024 * 1024) || 512 * 1024;
    return ok({ project_id: p.project.id, path: PATHS.mockup, exists: cur.exists, mockup_id: p.project.current_mockup_id || null, design_approved_at: p.project.design_approved_at || null, sha256: cur.sha256, bytes: cur.size ?? 0, truncated: (cur.content || '').length > max, html: cur.exists ? cur.content.slice(0, max) : null });
  });

  const write_mockup = mutation('write_mockup', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    if (p.project.design_approved_at && args.after_approval !== true) return err('The design is already approved; the mockup is the historical contract. Pass after_approval: true to overwrite it anyway (builds still read design.css / inventory.json).');
    const html = String(args.html || '');
    if (!html.trim() || !/<html|<body|<main|<div/i.test(html)) return err('html must be a complete mockup document');
    if (Buffer.byteLength(html) > 2 * 1024 * 1024) return err('mockup is over 2 MB');
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const x = await extra();
    const plausible = x.conceptLogic.isPlausibleMockup(html);
    const d = dry(args, { path: PATHS.mockup, bytes: Buffer.byteLength(html), sha256: sha256Hex(Buffer.from(html)), plausible_mockup: plausible }); if (d) return d;
    if (!plausible && args.force !== true) return err('This does not look like a Stage-1 mockup (no screens/sections the extractor can read). Pass force: true to write it anyway.');
    const w = await writeState({ incusName: p.incusName, rel: PATHS.mockup, content: html, args, note, message: 'mock2: mockup written over MCP' });
    if (w.error) return err(w.error);
    const mockupId = p.project.current_mockup_id || `mk-mcp-${Date.now().toString(36)}`;
    const histRel = x.conceptLogic.mockupFileName(mockupId);
    await verifiedContainerWrite(p.incusName, `${M2_APP_DIR}/${histRel}`, html, { label: histRel }).catch(() => null);
    if (!p.project.current_mockup_id) p.m.projects.updateProject(p.project.id, { current_mockup_id: mockupId, last_activity_at: new Date().toISOString() });
    note.summary = `mockup written (${w.bytes} bytes)`;
    return ok({ ...w, mockup_id: mockupId, history_copy: histRel, preview: projectUrl(p.project, p.m.domains) ? `${projectUrl(p.project, p.m.domains)}/_preview/` : null, next: `approve_design({ project_id: ${p.project.id}, confirm: true }) extracts tokens, design.css and the inventory (a model call).` });
  });

  const approve_design = mutation('approve_design', { subjectType: 'mock2_project', flag: 'mcp.builds' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id;
    const build = args.build === 'none' ? 'none' : 'all';
    const plan = { project_id: p.project.id, mockup_id: p.project.current_mockup_id || null, already_approved: !!p.project.design_approved_at, extracts: ['state/design-tokens.json', 'state/design.css', 'state/inventory.json'], then: build === 'all' ? 'one MVP build' : 'no build', spends: 'the project\'s model budget (inventory + token extraction, plus the build)' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Approve the design of ${p.project.name} (extraction is a model call${build === 'all' ? ', then an MVP build starts' : ''}).`); if (gate) return gate;
    const x = await extra();
    let result;
    try { result = await x.concept.startDesignApproval({ project: p.project, user: mcpUser(auth), actingAsAdmin: 1, buildStrategy: build }); } catch (e) { return err(`Could not approve the design: ${e?.message || e}`); }
    if (result.status === 'error') { note.refused = true; return err(result.error); }
    note.summary = `design approval started (build: ${build})`;
    note.detail = { cycle_id: result.cycle?.id || null, build };
    return ok({ started: true, ...plan, cycle_id: result.cycle?.id || null, job: x.concept.getConceptJobStatus(p.project.id), next: `Poll get_project({ project_id: ${p.project.id} }) until design_approved_at is set, then get_inventory.` });
  });

  /* ------------------------------ inventory ------------------------------- */

  const get_inventory = reader('get_inventory', async (args) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    const cur = await readState(p.incusName, PATHS.inventory);
    if (cur.error) return err(cur.error);
    let inventory = null; let parseError = null;
    if (cur.exists) { try { inventory = JSON.parse(cur.content); } catch (e) { parseError = e?.message; } }
    const x = await extra();
    return ok({ project_id: p.project.id, path: PATHS.inventory, exists: cur.exists, sha256: cur.sha256, inventory, ...(parseError ? { parse_error: parseError, raw: cur.content.slice(0, 20000) } : {}), ...(inventory ? { counts: x.conceptLogic.inventoryCounts(inventory), lint: x.conceptLogic.lintInventory(inventory) } : {}) });
  });

  const update_inventory = mutation('update_inventory', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    let inv = args.inventory;
    if (typeof inv === 'string') { try { inv = JSON.parse(inv); } catch (e) { return err(`inventory is not valid JSON: ${e?.message}`); } }
    if (!inv || typeof inv !== 'object' || Array.isArray(inv)) return err('inventory must be a JSON object ({ screens: [...] , ... })');
    const x = await extra();
    if (!Array.isArray(inv.screens)) return err('inventory.screens must be an array (the shape design approval writes)');
    const lint = x.conceptLogic.lintInventory(inv);
    const content = `${JSON.stringify(inv, null, 2)}\n`;
    const d = dry(args, { path: PATHS.inventory, counts: x.conceptLogic.inventoryCounts(inv), lint, bytes: Buffer.byteLength(content) }); if (d) return d;
    const w = await writeState({ incusName: p.incusName, rel: PATHS.inventory, content, args, note, message: 'mock2: inventory updated over MCP' });
    if (w.error) return err(w.error);
    note.summary = `inventory updated (${x.conceptLogic.inventoryCounts(inv).screens ?? inv.screens.length} screens)`;
    return ok({ ...w, counts: x.conceptLogic.inventoryCounts(inv), lint });
  });

  /* ---------------------------- rules / interview ------------------------- */

  const get_rules = reader('get_rules', async (args) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    const cur = await readState(p.incusName, PATHS.rules);
    if (cur.error) return err(cur.error);
    const x = await extra();
    const auditRan = x.questions.listQuestionsForProject(p.project.id).length > 0;
    const view = x.rulesView.rulesView({ rulesMd: cur.content, packText: x.rulesPack.CRUD_RULES_PACK, auditRan });
    return ok({ project_id: p.project.id, path: PATHS.rules, exists: cur.exists, sha256: cur.sha256, ...view, ...(args.raw === true ? { markdown: cur.content } : {}) });
  });

  const append_rule = mutation('append_rule', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
    const rule = String(args.rule || '').trim();
    if (!rule || rule.length > 4000) return err('rule is required (max 4000 chars): one testable, plain-language rule');
    const tag = ['confirmed', 'draft', 'observed'].includes(args.tag) ? args.tag : 'confirmed';
    const heading = args.heading ? String(args.heading).trim().slice(0, 120) : null;
    const cur = await readState(p.incusName, PATHS.rules);
    if (cur.error) return err(cur.error);
    const anchor = `mcp-rule-${Date.now().toString(36)}`;
    const block = heading
      ? `## ${heading}\n<!-- ${anchor} -->\n\n${rule} [${tag}]\n`
      : `- ${rule} [${tag}] <!-- ${anchor} -->\n`;
    const base = String(cur.content || '').replace(/\s+$/, '');
    const md = base ? `${base}\n\n${block}` : `# Project rules\n\nConfirmed domain rules for this project.\n\n${block}`;
    const d = dry(args, { path: PATHS.rules, appends: block, tag }); if (d) return d;
    const w = await writeState({ incusName: p.incusName, rel: PATHS.rules, content: md, args, note, message: `mock2: rule appended over MCP (${tag})` });
    if (w.error) return err(w.error);
    note.summary = `rule appended [${tag}]: ${rule.slice(0, 80)}`;
    return ok({ ...w, anchor, tag, note: 'A [confirmed] rule counts toward the Define-stage gate; the next build reads rules.md as-is.' });
  });

  const run_interview = mutation('run_interview', { subjectType: 'mock2_project', flag: 'mcp.builds' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id;
    const x = await extra();
    const open = x.questions.listQuestionsForProject(p.project.id, { status: 'open' }).map(x.auditLogic.publicQuestionShape);
    const answers = Array.isArray(args.answers) ? args.answers : [];
    if (!answers.length) {
      note.ledger = false;
      const all = x.questions.listQuestionsForProject(p.project.id).map(x.auditLogic.publicQuestionShape);
      return ok({ project_id: p.project.id, open_questions: open, answered: all.filter((q) => q.status !== 'open').length, note: open.length ? 'Answer with answers: [{ question_id, answer }]. Editor questions append confirmed rules; admin-routed ones are decided in the dashboard queue.' : 'No open interview questions. A build (start_project_build) runs the Stage-2 audit and raises them when the rules leave a gap.' });
    }
    const plan = answers.map((a) => ({ question_id: a.question_id, answer: String(a.answer || '').slice(0, 200) }));
    const d = dry(args, { answers: plan, open: open.length }); if (d) return d;
    const gate = confirmFlag(args, note, `Record ${answers.length} interview answer(s) on ${p.project.name} (each appends a confirmed rule and may resume a blocked build).`); if (gate) return gate;
    const results = [];
    for (const a of answers) {
      const q = x.questions.getQuestion(Number(a.question_id));
      if (!q || q.project_id !== p.project.id) { results.push({ question_id: a.question_id, ok: false, error: 'question not found on this project' }); continue; }
      try {
        const r = await x.audit.answerAuditQuestion({ project: p.m.projects.getProject(p.project.id), question: q, answer: String(a.answer || ''), user: mcpUser(auth), actingAsAdmin: 1 });
        results.push({ question_id: q.id, ok: !!r.ok, ...(r.ok ? { resumed: !!r.resumed, question: x.auditLogic.publicQuestionShape(r.question) } : { error: r.error }) });
      } catch (e) { results.push({ question_id: q.id, ok: false, error: e?.message || String(e) }); }
    }
    const okCount = results.filter((r) => r.ok).length;
    note.summary = `interview: ${okCount}/${answers.length} answers recorded`;
    note.detail = { answered: results.filter((r) => r.ok).map((r) => r.question_id) };
    const remaining = x.questions.listQuestionsForProject(p.project.id, { status: 'open' }).map(x.auditLogic.publicQuestionShape);
    return ok({ recorded: okCount, results, open_questions: remaining, resumed_build: results.some((r) => r.resumed) });
  });

  /* ------------------------------ checklist ------------------------------- */

  const get_production_checklist = reader('get_production_checklist', async (args) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    const cur = await readState(p.incusName, PATHS.checklist);
    if (cur.error) return err(cur.error);
    const items = parseChecklist(cur.content);
    const latest = p.m.cycles.latestCycle(p.project.id);
    return ok({ project_id: p.project.id, path: PATHS.checklist, exists: cur.exists, sha256: cur.sha256, counts: { total: items.length, pass: items.filter((i) => i.status === 'pass').length, open: items.filter((i) => i.status === 'open').length, waived: items.filter((i) => i.status === 'waived').length }, items, latest_build: latest ? { id: latest.id, status: latest.status, verification_state: latest.verification_state } : null, ...(args.raw === true ? { markdown: cur.content } : {}) });
  });

  const run_checklist = mutation('run_checklist', { subjectType: 'mock2_project', flag: 'mcp.builds' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id;
    const x = await extra();
    const guard = liveBuildGuard(p.m, p.project);
    const plan = { project_id: p.project.id, runs: 'the production-check build (full lane: the gate battery plus the checklist walk)', writes: PATHS.checklist, spends: 'the project\'s model budget', ...(guard ? { blocked_by: guard } : {}) };
    const d = dry(args, plan); if (d) return d;
    if (guard) return err(guard);
    const gate = confirmFlag(args, note, `Run the production checklist on ${p.project.name} (a full build cycle; spends the model budget).`); if (gate) return gate;
    let result;
    try { result = await x.audit.startBuild({ project: p.project, instruction: x.screenPlanLogic.PRODUCTION_CHECK_INSTRUCTION, user: mcpUser(auth), actingAsAdmin: 1, buildMode: 'full', origin: 'operator' }); } catch (e) { return err(`Could not start the production check: ${e?.message || e}`); }
    if (result.status === 'error' || result.status === 'refused') { note.refused = true; return err(result.error); }
    note.summary = 'production checklist run started';
    note.detail = { cycle_id: result.cycle?.id || null };
    return ok({ started: true, ...plan, build: x.cycleLogic.publicCycleShape(result.cycle), next: `get_build({ project_id: ${p.project.id}, build_id: ${result.cycle?.id} }) then get_production_checklist.` });
  });

  const record_check = mutation('record_check', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const p = await project(args);
    if (p.error) return err(p.error);
    note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
    const cur = await readState(p.incusName, PATHS.checklist);
    if (cur.error) return err(cur.error);
    if (!cur.exists) return err(`${PATHS.checklist} does not exist yet — run_checklist or the scaffold creates it`);
    const status = String(args.status || '');
    const r = recordChecklistItem(cur.content, { match: args.item, status, note: args.note ? String(args.note).slice(0, 500) : null });
    if (r.error) return err(r.error);
    const d = dry(args, { item: r.item, note: args.note || null }); if (d) return d;
    const w = await writeState({ incusName: p.incusName, rel: PATHS.checklist, content: r.md, args, note, message: `mock2: checklist "${r.item.text.slice(0, 60)}" → ${status}` });
    if (w.error) return err(w.error);
    note.summary = `checklist: ${r.item.text.slice(0, 60)} → ${status}`;
    return ok({ ...w, item: r.item, counts: (() => { const items = parseChecklist(r.md); return { total: items.length, pass: items.filter((i) => i.status === 'pass').length, open: items.filter((i) => i.status === 'open').length, waived: items.filter((i) => i.status === 'waived').length }; })() });
  });

  /* ----------------------------- handoff / work --------------------------- */

  function textReader(name, rel) {
    return reader(name, async (args) => {
      const p = await project(args);
      if (p.error) return err(p.error);
      const cur = await readState(p.incusName, rel);
      if (cur.error) return err(cur.error);
      return ok({ project_id: p.project.id, path: rel, exists: cur.exists, sha256: cur.sha256, total_lines: cur.total_lines ?? 0, content: cur.content });
    });
  }
  function textWriter(name, rel, { append = false } = {}) {
    return mutation(name, { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
      const p = await project(args);
      if (p.error) return err(p.error);
      note.subject_id = p.project.id; note.project_id = p.project.id; note.project = p.project;
      const guard = liveBuildGuard(p.m, p.project); if (guard) return err(guard);
      const text = String(args.content ?? '');
      if (!text.trim()) return err('content is required');
      if (Buffer.byteLength(text) > 512 * 1024) return err('content is over 512 KB');
      let content = text.endsWith('\n') ? text : `${text}\n`;
      if (append || args.append === true) {
        const cur = await readState(p.incusName, rel);
        if (cur.error) return err(cur.error);
        content = `${String(cur.content || '').replace(/\s+$/, '')}${cur.exists && cur.content.trim() ? '\n\n' : ''}${content}`;
      }
      const d = dry(args, { path: rel, bytes: Buffer.byteLength(content), mode: append || args.append === true ? 'append' : 'replace' }); if (d) return d;
      const w = await writeState({ incusName: p.incusName, rel, content, args, note, message: `mock2: ${rel} updated over MCP` });
      if (w.error) return err(w.error);
      note.summary = `${rel} ${append || args.append === true ? 'appended' : 'written'}`;
      return ok(w);
    });
  }

  const get_handoff = textReader('get_handoff', PATHS.handoff);
  const write_handoff = textWriter('write_handoff', PATHS.handoff);
  const get_work = textReader('get_work', PATHS.work);
  const update_work = textWriter('update_work', PATHS.work);

  /* ------------------------------ run ledger ------------------------------ */

  const append_run_ledger = mutation('append_run_ledger', { subjectType: 'mock2_project' }, async (args, auth, req, note) => {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return err('Project not found');
    note.subject_id = p.id; note.project_id = p.id;
    const x = await extra();
    const cycleId = args.build_id != null ? Number(args.build_id) : null;
    if (cycleId != null) { const c = m.cycles.getCycle(cycleId); if (!c || c.project_id !== p.id) return err('build_id is not a build on this project'); }
    const step = String(args.step || 'mcp').slice(0, 60);
    const entry = { projectId: p.id, cycleId, model: args.model ? String(args.model).slice(0, 80) : null, inputTokens: intIn(args.input_tokens, 0, 1e9) ?? 0, outputTokens: intIn(args.output_tokens, 0, 1e9) ?? 0, costCents: intIn(args.cost_cents, 0, 1e8) ?? 0, wallClockMs: intIn(args.wall_clock_ms, 0, 1e9) ?? 0, step, userId: auth.created_by || null };
    const d = dry(args, entry); if (d) return d;
    const row = x.quotas.insertLedgerEntry(entry);
    note.summary = `run ledger: ${step} ${entry.costCents}¢`;
    note.detail = { ledger_id: row?.id ?? null, step, cost_cents: entry.costCents };
    return ok({ appended: true, entry: row || entry, note: 'Counted against the project\'s quota like a harness call; use it for out-of-platform spend (a chat-lane run on a subscription is 0¢).' });
  });

  const get_run_ledger = reader('get_run_ledger', async (args) => {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return err('Project not found');
    const x = await extra();
    const since = args.since ? String(args.since) : new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const rows = x.quotas.ledgerSince(p.id, since, 'project');
    const byStep = {};
    let cents = 0; let inTok = 0; let outTok = 0;
    for (const r of rows) { cents += r.cost_cents || 0; inTok += r.input_tokens || 0; outTok += r.output_tokens || 0; const k = r.step || 'unattributed'; byStep[k] = byStep[k] || { calls: 0, cost_cents: 0 }; byStep[k].calls += 1; byStep[k].cost_cents += r.cost_cents || 0; }
    return ok({ project_id: p.id, since, calls: rows.length, cost_cents: cents, input_tokens: inTok, output_tokens: outTok, by_step: byStep, entries: rows.slice(-(intIn(args.limit, 1, 1000) || 200)) });
  });

  const list_runs = reader('list_runs', async (args) => {
    const m = await mock2Modules();
    const x = await extra();
    const limit = intIn(args.limit, 1, 500) || 50;
    const status = args.status ? String(args.status) : null;
    const where = []; const params = [];
    if (status) { where.push('c.status = ?'); params.push(status); }
    if (args.project_id != null) { where.push('c.project_id = ?'); params.push(Number(args.project_id)); }
    if (args.since) { where.push('c.created_at >= ?'); params.push(String(args.since)); }
    const rows = x.mock2Db.getMock2Db().prepare(`SELECT c.*, p.name AS project_name FROM mock2_cycles c LEFT JOIN mock2_projects p ON p.id = c.project_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT ?`).all(...params, limit);
    return ok({ count: rows.length, runs: rows.map((c) => ({ project_id: c.project_id, project: c.project_name, ...x.cycleLogic.publicCycleShape(c), feedback: x.cycleEvents.getCycleFeedback(c.id) })) });
  });

  const review_run = mutation('review_run', { subjectType: 'mock2_cycle' }, async (args, auth, req, note) => {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return err('Project not found');
    const cycle = m.cycles.getCycle(Number(args.build_id));
    if (!cycle || cycle.project_id !== p.id) return err('Build not found on this project');
    note.subject_id = cycle.id; note.project_id = p.id; note.project = p;
    if (['queued', 'estimating', 'running'].includes(cycle.status) || String(cycle.status).startsWith('awaiting')) return err(`Build ${cycle.id} is ${cycle.status} — review it once it has finished`);
    const score = intIn(args.score, 1, 5);
    if (!score) return err('score must be 1–5');
    const rating = args.rating === 'down' || score <= 2 ? 'down' : 'up';
    const text = args.note != null ? String(args.note).trim().slice(0, 4000) : '';
    if (rating === 'down' && !text) return err('A score of 1–2 (or rating: "down") needs a note saying what went wrong');
    const findings = Array.isArray(args.findings) ? args.findings.map((f) => String(f).slice(0, 300)).slice(0, 50) : [];
    const x = await extra();
    const plan = { build_id: cycle.id, score, rating, findings: findings.length, previous: x.cycleEvents.getCycleFeedback(cycle.id) };
    const d = dry(args, plan); if (d) return d;
    const body = `[score ${score}/5]${text ? ` ${text}` : ''}${findings.length ? `\n\nFindings:\n${findings.map((f) => `- ${f}`).join('\n')}` : ''}`;
    x.cycleEvents.recordCycleFeedback({ projectId: p.id, cycleId: cycle.id, rating, note: body, userId: auth.created_by || null });
    note.summary = `review of build ${cycle.id}: ${score}/5 (${rating})`;
    note.detail = { score, rating, findings };
    return ok({ recorded: true, build_id: cycle.id, score, rating, feedback: x.cycleEvents.getCycleFeedback(cycle.id), note: 'Stored as the build\'s feedback event (the same record the dashboard\'s thumbs write) and in the MCP ledger; the score prefix is what list_runs shows.' });
  });

  /* ----------------------------- change records --------------------------- */

  const list_change_records = reader('list_change_records', async (args) => {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return err('Project not found');
    const rows = m.changeRecords.listChangeRecords(p.id);
    const chain = m.changeRecords.verifyProjectChain(p.id);
    const limit = intIn(args.limit, 1, 1000) || 100;
    return ok({ project_id: p.id, count: rows.length, chain_ok: chain.ok, chain_broken_at: chain.brokenAt ?? null, records: rows.slice(-limit).map((r) => ({ seq: r.seq, hash: r.hash, prev_hash: r.prev_hash, summary: r.summary, commit_sha: r.commit_sha, cycle_id: r.cycle_id, initiated_by: r.initiated_by, acting_as_admin: !!r.acting_as_admin, framework_version: r.framework_version, gates_run: r.gates_run, rules_touched: r.rules_touched, created_at: r.created_at })) });
  });

  const get_change_record = reader('get_change_record', async (args) => {
    const m = await mock2Modules();
    const p = m.projects.getProject(Number(args.project_id));
    if (!p) return err('Project not found');
    const seq = intIn(args.seq, 1, 1e9);
    if (!seq) return err('seq is required');
    const row = m.changeRecords.listChangeRecords(p.id).find((r) => Number(r.seq) === seq);
    if (!row) return err(`No change record #${seq} on this project`);
    const mirror = m.changeRecords.changeRecordMirror(row);
    let onDisk = null;
    try {
      const incusName = projectContainerName(m, p);
      const r = await readProjectText(incusName, `state/changes/${seq}.json`);
      onDisk = r.error ? { present: false, error: r.absent ? 'not mirrored' : r.error } : { present: true, sha256: r.sha256, matches: r.content.trim() === JSON.stringify(mirror, null, 2).trim() };
    } catch { onDisk = null; }
    return ok({ project_id: p.id, record: row, mirror, mirror_on_disk: onDisk });
  });

  return {
    start_project_build, list_builds, get_build,
    get_mockup, write_mockup, approve_design,
    get_inventory, update_inventory,
    get_rules, append_rule, run_interview,
    get_production_checklist, run_checklist, record_check,
    get_handoff, write_handoff, get_work, update_work,
    append_run_ledger, get_run_ledger, list_runs, review_run,
    list_change_records, get_change_record,
  };
}
