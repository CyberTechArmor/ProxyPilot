// Mock2 DEMO CONTENT — the native half (route discovery, model call, execution).
//
// See demo-content-logic.js for WHY. In short: the design review screenshots an
// empty app and can therefore only critique chrome, and every one of its
// findings so far has been chrome.
//
// The calls go through the app's OWN API with the capture account's session and
// nothing else — "not the super admin or any users". The operator's account is
// never touched, no row is ever written directly, and the seeder runs once per
// project behind a marker.
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { DEFAULT_WEB_PORT } from './template.js';
import { callStepTurn, stepSystemPrompt } from './harness-steps.js';
import { buildRunnerReady } from './runner.js';
import { insertLedgerEntry } from './quotas.js';
import { costCentsForUsage } from './quota-logic.js';
import { effectivePrice } from './connectors.js';
import { getReviewLogin } from './review-account.js';
import {
  DEMO_SEED_MARKER, buildDemoContentPrompt, buildDemoContentTask, parseDemoCalls,
  resolveRefs, demoSeedNote, parseSeedRun, CALL_TIMEOUT_S,
} from './demo-content-logic.js';

const APP_DIR = '/srv/app';

function containerSh(containerName, script, { timeoutMs = 60000 } = {}) {
  return sh(`printf '%s' '${b64(script)}' | base64 -d | incus exec ${containerName} -- sh`, { timeoutMs });
}

async function readFile(containerName, relPath, { timeoutMs = 20000 } = {}) {
  try {
    const r = await containerSh(containerName, `cat '${APP_DIR}/${relPath}' 2>/dev/null`, { timeoutMs });
    return r.code === 0 ? (r.stdout || '') : '';
  } catch { return ''; }
}

// Has this project already been filled? The marker is in the container so a
// restored checkpoint restores the fact with it.
export async function isSeeded(containerName) {
  const r = await readFile(containerName, DEMO_SEED_MARKER, { timeoutMs: 15000 });
  return !!r.trim();
}

// The app's real routes, so the seeder cannot invent an endpoint. Grepped out
// of the source rather than asked for: a route table the model derives is a
// route table the model can be wrong about.
async function discoverRoutes(containerName) {
  const script = [
    `cd '${APP_DIR}' 2>/dev/null || exit 0`,
    // Express/Fastify-shaped registrations in the app's own source.
    `grep -rhoE "(router|app|api)\\.(post|put|patch|get)\\(\\s*['\\"][^'\\"]+['\\"]" src 2>/dev/null | head -200`,
    '',
  ].join('\n');
  try {
    const r = await containerSh(containerName, script, { timeoutMs: 30000 });
    const out = [];
    for (const line of String(r.stdout || '').split('\n')) {
      const m = /\.(post|put|patch|get)\(\s*['"]([^'"]+)['"]/i.exec(line);
      if (m && m[2].startsWith('/')) out.push(`${m[1].toUpperCase()} ${m[2]}`);
    }
    return [...new Set(out)];
  } catch { return []; }
}

// Run the calls inside the container, signed in as the capture account.
//
// One node script rather than N execs: a fresh `incus exec` per call would be
// twelve container round-trips for twelve notes, and the session cookie would
// have to survive between them.
function runnerScript({ base, email, password, calls }) {
  const payload = JSON.stringify({ base, email, password, calls, timeout: CALL_TIMEOUT_S * 1000 });
  const src = [
    'import fs from "node:fs";',
    'const cfg = JSON.parse(fs.readFileSync(process.env.PLAN, "utf8"));',
    'const results = [];',
    'let created = 0, failed = 0, skipped = 0;',
    '// Sign in FIRST and keep the cookie: every call below is this account and',
    '// no other. An unauthenticated seed would either 401 or, worse, write',
    '// content nobody owns.',
    'let cookie = "";',
    'try {',
    '  const r = await fetch(cfg.base + "/api/auth/login", {',
    '    method: "POST", headers: { "content-type": "application/json" },',
    '    body: JSON.stringify({ email: cfg.email, password: cfg.password }),',
    '    signal: AbortSignal.timeout(cfg.timeout),',
    '  });',
    '  cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");',
    '  if (!r.ok && !cookie) { console.log("SEED:noauth:" + r.status); process.exit(0); }',
    '} catch (e) { console.log("SEED:noauth:" + String(e && e.message).slice(0, 80)); process.exit(0); }',
    'for (const c of cfg.calls) {',
    '  try {',
    '    const res = await fetch(cfg.base + c.path, {',
    '      method: c.method,',
    '      headers: { "content-type": "application/json", cookie },',
    '      body: JSON.stringify(c.body ?? {}),',
    '      signal: AbortSignal.timeout(cfg.timeout),',
    '    });',
    '    let json = null;',
    '    try { json = await res.json(); } catch { json = null; }',
    '    // Unwrap the common { data: {...} } envelope so "$1.id" finds the id',
    '    // whichever shape this app returns.',
    '    results.push(json && typeof json === "object" ? (json.data ?? json.item ?? json) : null);',
    '    if (res.ok) created++; else failed++;',
    '    console.log("SEED:call:" + res.status + ":" + c.method + " " + c.path);',
    '  } catch (e) {',
    '    results.push(null); failed++;',
    '    console.log("SEED:call:000:" + c.method + " " + c.path);',
    '  }',
    '}',
    'console.log("SEED:done:" + created + ":" + failed + ":" + skipped);',
    'console.log("SEED:ids:" + JSON.stringify(results.map((r) => (r && (r.id ?? r.uuid)) ?? null)));',
  ].join('\n');
  return [
    'set -u',
    `cd '${APP_DIR}' 2>/dev/null || exit 0`,
    'WORK=$(mktemp -d "$PWD/.pp-demo-XXXXXX")',
    `trap 'rm -rf "$WORK"' EXIT INT TERM`,
    // The plan carries the capture account's password. A 0600 file, never an
    // argv: `ps` inside the container is readable by the app itself.
    'umask 077',
    `cat > "$WORK/plan.json" <<'PP_DEMO_EOF'`,
    payload,
    'PP_DEMO_EOF',
    `cat > "$WORK/run.mjs" <<'PP_DEMO_JS_EOF'`,
    src,
    'PP_DEMO_JS_EOF',
    'PLAN="$WORK/plan.json" node "$WORK/run.mjs" 2>&1 | tail -40',
    '',
  ].join('\n');
}

// seedDemoContent(project, { force }) → { ok, created, failed, skipped, note, error }
//
// Best-effort and never throws: an app with no create endpoints, no capture
// account, or a model that cannot read its routes all mean "no demo content",
// which is exactly where every project is today.
export async function seedDemoContent(project, { force = false, count = 12, initiatedBy = null } = {}) {
  const containerName = project?.container_name;
  if (!containerName || project.lifecycle !== 'active') {
    return { ok: false, created: 0, error: 'The project is not online — start it, then try again.' };
  }
  if (!force && await isSeeded(containerName)) {
    return { ok: true, created: 0, alreadySeeded: true, error: null };
  }
  // The capture account is the ONLY identity this ever uses. No account, no
  // seed — the alternative would be writing content that belongs to nobody or,
  // worse, to the operator.
  const login = getReviewLogin(project.id);
  if (!login?.email || !login?.password) {
    return { ok: false, created: 0, error: 'This project has no screen account yet — create it in App access first.' };
  }
  const ready = buildRunnerReady();
  if (!ready.ok) return { ok: false, created: 0, error: ready.reason || 'No model connector is ready.' };

  const routes = await discoverRoutes(containerName);
  const writable = routes.filter((r) => /^(POST|PUT|PATCH) /.test(r));
  if (!writable.length) {
    return { ok: false, created: 0, error: 'Could not find any create endpoints in this app, so there is nothing to fill it through.' };
  }
  const inventory = await readFile(containerName, 'state/inventory.json');

  const res = await callStepTurn('demo-content', {
    connector: ready.connector,
    apiKey: ready.apiKey,
    model: String(process.env.MOCK2_DEMO_CONTENT_MODEL || '').trim() || ready.model,
    system: stepSystemPrompt('demo-content', buildDemoContentPrompt(), {}),
    tools: [],
    transcript: [{
      role: 'user',
      text: buildDemoContentTask({ appName: project.name, routes: routes.join('\n'), inventory, count }),
    }],
    effort: 'high',
    thinking: null,
    timeoutMs: 180000,
  });

  try {
    const u = res?.usage || {};
    if (res?.ok) {
      insertLedgerEntry({
        projectId: project.id, cycleId: null, connectorId: ready.connector.id,
        model: res.modelUsed || ready.model,
        inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
        costCents: costCentsForUsage({
          inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0,
          cacheReadTokens: u.cacheReadInputTokens || 0, cacheWriteTokens: u.cacheCreationInputTokens || 0,
        }, effectivePrice(ready.connector.id, res.modelUsed || ready.model)),
        wallClockMs: 0, step: 'demo-content', userId: initiatedBy ?? null,
      });
    }
  } catch (e) { console.warn('[mock2] demo-content ledger write failed:', e?.message); }

  if (!res?.ok) return { ok: false, created: 0, error: res?.error || 'The model call failed.' };
  const allowedPaths = writable.map((r) => r.split(' ')[1]);
  const plan = parseDemoCalls(res.text, { allowedPaths });
  if (!plan) return { ok: false, created: 0, error: 'No usable calls came back — nothing was changed.' };

  // Cross-call references are resolved by the in-container runner as it goes,
  // so anything referencing a LATER call is dropped here rather than sending a
  // literal "$3.id" into a real row.
  const calls = [];
  let skipped = 0;
  for (let i = 0; i < plan.calls.length; i += 1) {
    const c = plan.calls[i];
    const body = resolveRefs(c.body, calls.map((_, j) => ({ id: `$${j + 1}.id` })));
    if (body === null) { skipped += 1; continue; }
    calls.push(c);
  }
  if (!calls.length) return { ok: false, created: 0, error: 'Every call referenced something that does not exist yet.' };

  let run;
  try {
    const out = await containerSh(containerName, runnerScript({
      base: `http://127.0.0.1:${project.web_port || DEFAULT_WEB_PORT}`,
      email: login.email, password: login.password, calls,
    }), { timeoutMs: 180000 });
    run = parseSeedRun(out?.stdout || '');
  } catch (e) {
    return { ok: false, created: 0, error: e?.message || 'The seeder could not be run in the container.' };
  }
  if (!run.ok) return { ok: false, created: run.created, failed: run.failed, error: run.reason };

  // The marker, so a review does not reseed on every run.
  try {
    const marker = JSON.stringify({ seededAt: new Date().toISOString(), created: run.created, account: login.email }, null, 2);
    await containerSh(containerName, [
      `mkdir -p '${APP_DIR}/state'`,
      `cat > '${APP_DIR}/${DEMO_SEED_MARKER}' <<'PP_MARK_EOF'`,
      marker,
      'PP_MARK_EOF',
      '',
    ].join('\n'), { timeoutMs: 20000 });
  } catch (e) { console.warn('[mock2] demo-seed marker write failed:', e?.message); }

  return {
    ok: true,
    created: run.created,
    failed: run.failed,
    skipped,
    account: login.email,
    note: demoSeedNote({ created: run.created, failed: run.failed, skipped, account: login.email }),
    error: null,
  };
}

export { isSeeded as isDemoSeeded, DEMO_SEED_MARKER };
export { parseSeedRun } from './demo-content-logic.js';
