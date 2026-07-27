// Prove the platform baseline catches the defect it exists for, against a REAL
// app, a REAL Postgres and a REAL browser: a viewer must not be offered the
// admin route, and must not reach the admin page by typing the URL.
//
// Run twice — once against the app as shipped (the guard works → PASS) and once
// with the server guard removed (→ the check must FAIL). A check that only ever
// passes proves nothing.
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  REVIEW_EMAIL, REVIEW_VIEWER_EMAIL, seedFixtureUserScript, parseSeedResult, reviewFixtureAccounts,
} from '/home/user/ProxyPilot/admin/backend/src/mock2/review-account-logic.js';
import { withBaselineChecks, uiCheckLogLines } from '/home/user/ProxyPilot/admin/backend/src/mock2/ui-check-logic.js';
import { runUiChecks } from '/home/user/ProxyPilot/admin/backend/src/mock2/ui-checks.js';

const APP = '/tmp/pp-wired';
const BASE = 'http://127.0.0.1:3999';
const DB = 'postgres://app@127.0.0.1:5432/app_seedtest';
const PASS = 'Reviewer-Chain-Test-9';

// 1) Seed BOTH fixtures in one pass.
const accounts = reviewFixtureAccounts({
  email: REVIEW_EMAIL, password: PASS,
  viewerEmail: REVIEW_VIEWER_EMAIL, viewerPassword: PASS,
});
writeFileSync('/tmp/rbac-seed.sh', seedFixtureUserScript({ accounts, appDir: APP }));
const seed = spawnSync('sh', ['/tmp/rbac-seed.sh'], { cwd: APP, encoding: 'utf8', env: { ...process.env, DATABASE_URL: DB } });
const seeded = parseSeedResult(seed.stdout || '');
console.log('1. seed →', JSON.stringify(seeded));
if (!seeded.ok) { console.log('\nFAIL — seeding'); process.exit(1); }
if (seeded.accounts.viewer === seeded.accounts.reviewer) {
  console.log(`\nFAIL — the viewer got the same role as the reviewer (${seeded.accounts.viewer})`);
  process.exit(1);
}
console.log(`   reviewer=${seeded.accounts.reviewer}  viewer=${seeded.accounts.viewer}`);

// 2) Build the spec the connector would build, from an EMPTY model spec —
//    the project-39/40 shape where nothing else would have run at all.
const spec = withBaselineChecks({ login: null, checks: [] }, {
  reviewLogin: { email: REVIEW_EMAIL, password: PASS },
  viewerLogin: { email: REVIEW_VIEWER_EMAIL, password: PASS },
});
console.log(`2. spec → ${spec.checks.length} baseline check(s), roles: ${Object.keys(spec.login.users).join(', ')}`);

// 3) Run them for real.
const run = await runUiChecks({ baseUrl: BASE, spec, checks: spec.checks });
console.log('3. run:', JSON.stringify({ ok: run.ok, unavailable: run.unavailable, detail: run.detail, n: run.results.length }));
for (const line of uiCheckLogLines(run.results)) console.log(`   ${line}`);

const byId = Object.fromEntries(run.results.map((r) => [r.id, r]));
const expectPass = process.env.EXPECT !== 'leak';
const denied = byId['platform-baseline-viewer-denied-admin'];
const notOffered = byId['platform-baseline-viewer-not-offered-admin'];

if (expectPass) {
  const ok = run.ok;
  console.log(ok ? '\nPASS — the guard holds and the baseline says so'
                 : `\nFAIL — baseline red on a correct app: ${uiCheckLogLines(run.results).filter((l) => l.includes('FAIL')).join('; ')}`);
  process.exit(ok ? 0 : 1);
}
// Leak mode: the server guard was removed, so the URL-typing check MUST fail.
const caught = denied && !denied.ok;
console.log(`\n${caught ? 'PASS' : 'FAIL'} — with the server guard removed, viewer-denied-admin ${caught ? 'FAILED as it must' : 'still passed (the check is useless)'}`);
console.log(`   (viewer-not-offered-admin: ${notOffered?.ok ? 'still passes — the link is hidden client-side, which is exactly why the URL check is the real one' : 'also failed'})`);
process.exit(caught ? 0 : 1);
