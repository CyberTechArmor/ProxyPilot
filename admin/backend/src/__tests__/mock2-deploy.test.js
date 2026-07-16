// Mock2 Run-phase tests — the deploy decision layer, the runtime scaffold seed,
// the manifest run contract, and the derived deploy statuses.
//
// Stub-first (risk R9 / docs/known-issues.md): imports ONLY pure modules
// (deploy-logic.js, template.js, scaffold.js, project-logic.js — none pull in
// better-sqlite3, Express, or Incus). The exec/host half (deploy.js) and the
// runner wiring are exercised by the manual verification checklist, not here, so
// this suite never worsens the fresh-checkout native-module test gap.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRunContract, deployPlan, deployStepLabel, buildDevServiceUnit,
  execStartForStartCommand, execStartForServePy, deployProjectStatus,
  deployFailureMessage, DEFAULT_RUN_CONTRACT, freeWebPortScript,
} from '../mock2/deploy-logic.js';
import {
  defaultManifest, buildSeedFiles, buildContainerSetupScript, parseManifestWebPort,
  MOCK2_TEMPLATE_VERSION,
} from '../mock2/template.js';
import { buildScaffoldFiles } from '../mock2/scaffold.js';
import { deriveProjectStatus } from '../mock2/project-logic.js';

// ---- parseRunContract (declared, not discovered — ADR-005) ----

test('parseRunContract reads the run block from the default manifest', () => {
  const c = parseRunContract(defaultManifest({ webPort: 3000 }));
  assert.equal(c.hasContract, true);
  assert.equal(c.runtime, 'node-express');
  assert.equal(c.install, 'npm ci || npm install');
  assert.equal(c.migrate, 'npm run migrate');
  assert.equal(c.build, 'npm run build');
  assert.equal(c.start, 'npm run start');
});

test('parseRunContract: no run block ⇒ hasContract false (old placeholder)', () => {
  const yaml = 'version: 1\nports:\n  web: 3000\n  postgres: 5432\n';
  const c = parseRunContract(yaml);
  assert.equal(c.hasContract, false);
  assert.equal(c.start, undefined);
});

// ---- freeWebPortScript (EADDRINUSE crash-loop fix — free the port before start) ----

test('freeWebPortScript stops the unit, kills the port holder, and clears the limiter', () => {
  const s = freeWebPortScript(3000);
  assert.match(s, /systemctl stop mock2-dev\.service/);
  assert.match(s, /fuser -k 3000\/tcp/);      // primary reaper
  assert.match(s, /lsof -t -i:3000/);         // fallback reaper
  assert.match(s, /sport = :3000/);           // last-resort ss parse
  assert.match(s, /systemctl reset-failed mock2-dev\.service/); // clear the restart-rate limit
  assert.match(s, /sleep 1/);                 // pauses for socket release
  // The unit is STARTED by deploy.js, not by this snippet (which only frees).
  assert.doesNotMatch(s, /systemctl start mock2-dev/);
  // Every step is best-effort so a clean deploy passes straight through.
  assert.ok(s.includes('|| true'));
});

test('freeWebPortScript interpolates the actual web port and defaults safely', () => {
  assert.match(freeWebPortScript(8080), /fuser -k 8080\/tcp/);
  assert.match(freeWebPortScript(8080), /:8080/);
  // A missing/garbage port falls back to 3000 rather than emitting `:NaN`.
  assert.match(freeWebPortScript(), /fuser -k 3000\/tcp/);
  assert.match(freeWebPortScript('nope'), /fuser -k 3000\/tcp/);
  assert.doesNotMatch(freeWebPortScript(undefined), /NaN/);
});

test('parseRunContract: start alone is enough for hasContract', () => {
  const c = parseRunContract('run:\n  start: node dist/server.js\n');
  assert.equal(c.hasContract, true);
  assert.equal(c.start, 'node dist/server.js');
  assert.equal(c.install, undefined);
});

test('parseRunContract strips surrounding quotes and preserves shell operators', () => {
  const c = parseRunContract('run:\n  install: "npm ci || npm install"\n  start: \'node dist/server.js\'\n');
  assert.equal(c.install, 'npm ci || npm install');
  assert.equal(c.start, 'node dist/server.js');
});

test('parseRunContract stops at the next top-level key (does not bleed)', () => {
  const yaml = 'run:\n  start: node dist/server.js\nother:\n  start: SHOULD_NOT_WIN\n';
  const c = parseRunContract(yaml);
  assert.equal(c.start, 'node dist/server.js');
});

test('parseRunContract tolerates blank lines and comments inside the block', () => {
  const yaml = 'run:\n  # how it runs\n  runtime: node-express\n\n  start: node dist/server.js\n';
  const c = parseRunContract(yaml);
  assert.equal(c.runtime, 'node-express');
  assert.equal(c.start, 'node dist/server.js');
});

test('parseRunContract on empty/garbage input is safe', () => {
  assert.equal(parseRunContract('').hasContract, false);
  assert.equal(parseRunContract(null).hasContract, false);
  assert.equal(parseRunContract(undefined).hasContract, false);
});

// ---- the systemd-unit string (the deploy rewrite target) ----

test('buildDevServiceUnit swaps only ExecStart; keeps port + WantedBy', () => {
  const unit = buildDevServiceUnit({ appDir: '/srv/app', webPort: 4321, execStart: '/bin/sh -lc \'exec npm run start\'' });
  assert.match(unit, /WorkingDirectory=\/srv\/app/);
  assert.match(unit, /Environment=PORT=4321/);
  assert.match(unit, /EnvironmentFile=-\/etc\/environment/);
  assert.match(unit, /ExecStart=\/bin\/sh -lc 'exec npm run start'/);
  assert.match(unit, /WantedBy=multi-user\.target/);
});

test('execStartForStartCommand wraps in a login shell and cds to the app dir', () => {
  const es = execStartForStartCommand('npm run start', { appDir: '/srv/app' });
  assert.equal(es, "/bin/sh -lc 'cd /srv/app && exec npm run start'");
});

test('execStartForStartCommand escapes single quotes so a bad command cannot break the unit', () => {
  const es = execStartForStartCommand("node -e 'process.exit(0)'", { appDir: '/srv/app' });
  // The embedded quotes are '\'' -escaped; the outer literal stays balanced.
  assert.ok(es.startsWith("/bin/sh -lc '"));
  assert.ok(es.endsWith("'"));
  assert.match(es, /'\\''/);
});

test('execStartForServePy reproduces the M2 placeholder ExecStart', () => {
  assert.equal(execStartForServePy('/srv/app'), '/usr/bin/python3 /srv/app/serve.py');
});

// ---- the deploy plan + labels ----

test('deployPlan orders install → migrate → build and skips omitted steps', () => {
  const full = deployPlan(DEFAULT_RUN_CONTRACT).map((s) => s.key);
  assert.deepEqual(full, ['install', 'migrate', 'build']);
  const partial = deployPlan({ install: 'npm i', start: 'node x' }).map((s) => s.key);
  assert.deepEqual(partial, ['install']);
  assert.deepEqual(deployPlan({ start: 'node x' }), []);
});

test('deployPlan steps carry bounded timeouts (R5)', () => {
  for (const s of deployPlan(DEFAULT_RUN_CONTRACT)) {
    assert.ok(Number.isInteger(s.timeoutMs) && s.timeoutMs > 0, `${s.key} timeout`);
  }
});

test('deployStepLabel is human-readable for each step', () => {
  for (const k of ['install', 'migrate', 'build', 'start', 'health']) {
    assert.match(deployStepLabel(k), /\S/);
  }
});

// ---- derived deploy status token ----

test('deployProjectStatus maps cycle deploy_status to the derived token', () => {
  assert.equal(deployProjectStatus('deploying'), 'deploying');
  assert.equal(deployProjectStatus('serving'), 'serving');
  assert.equal(deployProjectStatus('deploy_failed'), 'deploy_failed');
  assert.equal(deployProjectStatus(null), null);
  assert.equal(deployProjectStatus(undefined), null);
  assert.equal(deployProjectStatus('anything-else'), null);
});

test('deployFailureMessage names the failed step and hints egress on install failures', () => {
  const msg = deployFailureMessage('install', 'npm ERR! ECONNREFUSED registry.npmjs.org');
  assert.match(msg, /Dependency install failed/);
  assert.match(msg, /egress|NAT|npm registry/i);
  // A build failure is not blamed on egress.
  assert.doesNotMatch(deployFailureMessage('build', 'TS2304: cannot find name'), /egress|NAT/i);
});

// ---- derived project status (Run phase additions) ----

const activeProject = { lifecycle: 'active' };

test('deriveProjectStatus: serving when the latest cycle deployed + container running', () => {
  const s = deriveProjectStatus(activeProject, { editorCount: 1, containerState: 'running', deployState: 'serving' });
  assert.equal(s, 'serving');
});

test('deriveProjectStatus: online (not serving) with no deploy signal', () => {
  const s = deriveProjectStatus(activeProject, { editorCount: 1, containerState: 'running', deployState: null });
  assert.equal(s, 'online');
});

test('deriveProjectStatus: deploy_failed is surfaced ahead of liveness', () => {
  const s = deriveProjectStatus(activeProject, { editorCount: 1, containerState: 'running', deployState: 'deploy_failed' });
  assert.equal(s, 'deploy_failed');
});

test('deriveProjectStatus: deploying while the deploy runs', () => {
  const s = deriveProjectStatus(activeProject, { editorCount: 1, containerState: 'running', deployState: 'deploying' });
  assert.equal(s, 'deploying');
});

test('deriveProjectStatus: awaiting questions still win over deploy signal', () => {
  const s = deriveProjectStatus(activeProject, { editorCount: 1, containerState: 'running', openEditorQuestions: 1, deployState: 'serving' });
  assert.equal(s, 'awaiting_user');
});

test('deriveProjectStatus: unchanged when no deployState is passed (back-compat)', () => {
  assert.equal(deriveProjectStatus(activeProject, { editorCount: 1, containerState: 'running' }), 'online');
  assert.equal(deriveProjectStatus(activeProject, { editorCount: 1, containerState: 'stopped' }), 'idle');
  assert.equal(deriveProjectStatus({ lifecycle: 'archived' }, {}), 'archived');
});

// ---- the manifest run contract + the runtime scaffold seed (R8) ----

test('defaultManifest declares ports AND a parseable run contract', () => {
  const yaml = defaultManifest({ webPort: 8080 });
  assert.equal(parseManifestWebPort(yaml), 8080);
  assert.equal(parseRunContract(yaml).start, 'npm run start');
});

test('buildSeedFiles seeds the TS/Express/Drizzle scaffold, the manifest, and the placeholder', () => {
  const files = buildSeedFiles({ name: 'Demo' }, { webPort: 3000 });
  const paths = files.map((f) => f.path);
  // The real runtime scaffold (R8).
  for (const p of ['package.json', 'tsconfig.json', 'src/server.ts', 'src/app.ts', 'migrations/0001_init.sql', 'scripts/migrate.mjs']) {
    assert.ok(paths.includes(p), `seed missing ${p}`);
  }
  // The manifest with the run contract.
  assert.ok(paths.includes('mock2.yaml'));
  // The Concept-stage placeholder front door is still seeded.
  assert.ok(paths.includes('serve.py'));
  assert.ok(paths.includes('public/index.html'));
  assert.ok(paths.includes('state/mockups/.gitkeep'));
});

test('the seeded package.json start script matches the manifest run contract', () => {
  const files = buildSeedFiles({ name: 'Demo' }, { webPort: 3000 });
  const pkg = JSON.parse(files.find((f) => f.path === 'package.json').content);
  const contract = parseRunContract(files.find((f) => f.path === 'mock2.yaml').content);
  // start: "npm run start" → package.json has a "start" script node runs.
  assert.equal(contract.start, 'npm run start');
  assert.equal(pkg.scripts.start, 'node dist/server.js');
  assert.equal(pkg.scripts.build, 'tsc -p tsconfig.json');
  assert.equal(pkg.scripts.migrate, 'node scripts/migrate.mjs');
  // Constitution stack (framework-seed/constitution.md §2): Drizzle + pg + Zod.
  assert.ok(pkg.dependencies['drizzle-orm'] && pkg.dependencies.pg && pkg.dependencies.zod && pkg.dependencies.express);
});

test('the seed src binds the declared web port and mounts /_preview for Concept coexistence', () => {
  const files = buildScaffoldFiles({ name: 'Demo' });
  const app = files.find((f) => f.path === 'src/app.ts').content;
  const server = files.find((f) => f.path === 'src/server.ts').content;
  assert.match(app, /\/_preview/);
  assert.match(app, /state', 'mockups|state\/mockups/);
  assert.match(server, /config\.PORT/);
  // migrate.mjs is executable so `node scripts/migrate.mjs` works from the unit.
  assert.equal(files.find((f) => f.path === 'scripts/migrate.mjs').mode, 0o755);
});

test('the scaffold has no forbidden ORM/DB (constitution-lint would pass)', () => {
  const forbidden = /(mysql2|better-sqlite3|sqlite3|mongoose|mongodb|typeorm|sequelize|prisma|knex)/;
  for (const f of buildScaffoldFiles({ name: 'Demo' })) {
    if (f.path.startsWith('src/')) assert.doesNotMatch(f.content, forbidden, `${f.path} uses a forbidden datastore`);
  }
});

// ---- the container setup script (serve.py placeholder unit + node bootstrap) ----

test('buildContainerSetupScript seeds the serve.py placeholder unit and installs node at bootstrap', () => {
  const script = buildContainerSetupScript({ appDir: '/srv/app', webPort: 3000 });
  // The initial unit still runs serve.py (the deploy step rewrites it later).
  assert.match(script, /ExecStart=\/usr\/bin\/python3 \/srv\/app\/serve\.py/);
  // Node runtime baked in pre-fence so the deploy's npm install has a runtime.
  assert.match(script, /nodejs npm/);
  assert.match(script, /WantedBy=multi-user\.target/);
});

test('MOCK2_TEMPLATE_VERSION was bumped for the runtime scaffold', () => {
  assert.equal(MOCK2_TEMPLATE_VERSION, 'run-1');
});
