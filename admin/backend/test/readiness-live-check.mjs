// The readiness probe against a REAL app, both ways round.
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readinessScript, parseReadiness, readinessLogLines, readinessChatMessage } from '/home/user/ProxyPilot/admin/backend/src/mock2/readiness-logic.js';

const AUTH = { email: 'design-review@fixture.invalid', password: 'Reviewer-Chain-Test-9' };
writeFileSync('/tmp/ready.sh', readinessScript({ port: 3999, authed: AUTH }));
const r = spawnSync('sh', ['/tmp/ready.sh'], { encoding: 'utf8' });
console.log('raw:', JSON.stringify(r.stdout.trim()));
const parsed = parseReadiness(r.stdout);
for (const l of readinessLogLines(parsed)) console.log('  ' + l);
console.log('ready:', parsed.ready, '|', parsed.summary);
const msg = readinessChatMessage(parsed);
if (msg) console.log('\n--- chat message ---\n' + msg);
process.exit(process.env.EXPECT === 'broken' ? (parsed.ready ? 1 : 0) : (parsed.ready ? 0 : 1));
