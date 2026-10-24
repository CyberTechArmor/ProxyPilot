// Constitution §2 ("The stack and the application foundation") and the
// precedence line above the pinned upstream guidance. Pure file reads plus the
// prompt builders, native-free.
//
// These pin the user's decisions of 2026-10-24 (docs/features/app-foundation.md)
// to the text the build runner is actually prompted with, and pin the names the
// text cites to the shared contract, so a rename in foundation-contract.js or a
// re-sync of the pinned guidance cannot silently drop or contradict a rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import guidance from '../mock2/framework-seed/upstream-guidance.json' with { type: 'json' };
import { pinnedGuidanceHeader } from '../../../../scripts/sync-mock2-guidance.mjs';
import { buildRunnerSystemPrompt } from '../mock2/runner-logic.js';
import {
  STACK, FOUNDATION_CLI, HEALTH_STATUSES, LOCAL_EMBEDDINGS_WARNING, FOUNDATION_DATABASE_URL,
} from '../mock2/foundation-contract.js';

const SEED = new URL('../mock2/framework-seed/', import.meta.url);
const read = (name) => readFileSync(new URL(name, SEED), 'utf8');
const MARKER = '<!-- BEGIN PINNED MOCK2 GUIDANCE -->';

const constitution = read('constitution.md');
const platformPart = constitution.slice(0, constitution.indexOf(MARKER));
const section2 = platformPart.slice(
  platformPart.indexOf('## 2. The stack and the application foundation'),
  platformPart.indexOf('## 3. Scaffold conventions'),
);
// Markdown wraps lines; compare on single spaces.
const flat = (s) => s.replace(/\s+/g, ' ');
const s2 = flat(section2);

test('§2 is the stack and the application foundation, in the ProxyPilot-owned part', () => {
  assert.ok(platformPart.includes('## 2. The stack and the application foundation'));
  assert.ok(section2.length > 2000, '§2 must carry the rules, not a pointer');
  assert.doesNotMatch(platformPart, /## 2\. The stack \(the only stack\)/);
  assert.match(s2, /platform contract/);
  assert.match(s2, /does \*\*not\*\* supersede it/);
  // The stack lines code comments cite as "constitution §2" are still there.
  for (const line of ['**Language:** TypeScript (strict)', '**HTTP:** Express', '**Data access:** Drizzle ORM',
    '**Validation:** Zod', '**Testing:** Vitest', '**Reverse proxy / TLS:** Caddy']) {
    assert.ok(section2.includes(line), line);
  }
  assert.match(s2, /\*\*Profile:\*\* `cpr` \(the PRO application profile\) \*\*with the application foundation\*\*/);
  assert.match(s2, /Never record `Profile: none`, or a stack or database deviation, for a new application/);
});

test('§2 database rules: one database, explicit failure, no SQLite without the recorded request', () => {
  assert.match(s2, /PostgreSQL with pgvector, provisioned by the foundation when the application is created, is the only application database/);
  assert.match(s2, /A missing or unreachable database is an \*\*explicit failure\*\*/);
  assert.match(s2, /Never fall back to a default URL, an in-memory store, a JSON file, SQLite or PGlite/);
  // Every engine the design doc names for constitution-lint is named here too.
  for (const pkg of ['`sqlite3`', '`better-sqlite3`', '`node:sqlite`', '`bun:sqlite`', '`@libsql/*`', '`libsql`', '`sql.js`', 'PGlite as a server database']) {
    assert.ok(s2.includes(pkg), `§2 must name ${pkg}`);
  }
  assert.match(s2, /The \*\*only\*\* exception: the user explicitly asked for SQLite, and a person recorded that request/);
  assert.match(s2, /your task quotes it/);
  assert.match(s2, /Nothing in the repository can create the exception/);
  for (const path of ['state/rules.md', 'state/decisions.md', 'state/deviations/', '.github/copilot-instructions.md']) {
    assert.ok(s2.includes(path), `the builder-writable ${path} must be named as unable to create the exception`);
  }
  assert.match(s2, /An approved framework deviation does not replace it/);
});

test('§2 storage, embeddings, secrets, switches, vector spaces and health rules are all present', () => {
  assert.match(s2, /Object storage only through the storage adapter/);
  assert.match(s2, /any S3-compatible provider \(Cloudflare R2/);
  assert.match(s2, /Embeddings and vector search only through the foundation adapters/);
  assert.match(s2, /Feature code never imports an S3 SDK \(`@aws-sdk\/client-s3`/);
  assert.match(s2, /never calls an embedding HTTP API/);
  assert.match(s2, /Secrets are encrypted in the database, never in env files/);
  assert.match(s2, /Never write a secret to an env file \(`\.env`, `\/etc\/environment`/);
  assert.match(s2, /Switches never delete data/);
  assert.match(s2, /cannot be turned off until the person picks a replacement S3/);
  for (const cmd of ['docker compose down -v', 'docker volume rm', 'docker system prune']) assert.ok(s2.includes(cmd), cmd);
  assert.match(s2, /One vector space per index/);
  assert.match(s2, /re-embeds into a \*\*new\*\* index, validates it/);
  assert.match(s2, /Never mix vector spaces/);
  assert.match(s2, /Health is reported truthfully/);
  assert.match(s2, /A filled-in setting is never readiness/);
  assert.match(s2, /never reported as production-ready/);
  assert.match(s2, /Existing projects\.\*\* Projects created before the foundation keep their in-guest PostgreSQL/);
});

test('§2 cites the shared contract by its real names and values', () => {
  assert.ok(s2.includes(`\`${STACK.composeFile}\``), 'guest compose path');
  assert.ok(s2.includes(`\`node ${FOUNDATION_CLI}\``), 'foundation CLI');
  assert.ok(s2.includes(`\`${STACK.embeddings.model}\`, ${STACK.embeddings.dimensions} dimensions`), 'local model + dimensions');
  assert.ok(s2.includes(`private bucket \`${STACK.storage.bucket}\``), 'bundled bucket');
  const [pgvectorTag, pgMajor] = STACK.postgres.image.split(':')[1].split('-pg');
  assert.ok(s2.includes(`pgvector ${pgvectorTag}`) && s2.includes(`PostgreSQL ${pgMajor}.`), 'image pins');
  assert.ok(s2.includes('`LOCAL_EMBEDDINGS_WARNING`') && LOCAL_EMBEDDINGS_WARNING.length > 0);
  assert.ok(HEALTH_STATUSES.includes('missing_credentials') && s2.includes('`missing_credentials`'));
  // The socket URL has no password, which is why §2 may call DATABASE_URL "not a secret".
  assert.doesNotMatch(FOUNDATION_DATABASE_URL, /:[^/@:]+@/);
  assert.match(s2, /`DATABASE_URL` carries no password, so it is not a secret/);
});

test('§2 states what checks it honestly and keeps the platform-amendment rule', () => {
  assert.match(s2, /The `constitution-lint` check runs in \*\*every\*\* build tier \(full, MVP and quick\)/);
  assert.match(s2, /reads the source and `package.json`/);
  assert.match(s2, /independent review pass checks the adapter, secret and health rules/);
  assert.match(s2, /Any other genuine datastore is a platform amendment to this section, never a per-project decision/);
});

test('precedence: §2 names the upstream loopholes it closes, and the generated header says §2 is not superseded', () => {
  for (const loophole of [
    'technology choices live in a named profile', '`Profile: none`', 'adopting Mock2 never rewrites a stack',
    'never provisions external services or adds unused services', 'declaring AI alone does not select embeddings',
    'an embedding model may be replaced or fail over automatically', 'only SQLite *as the production database*',
  ]) assert.ok(s2.includes(loophole), `precedence must answer: ${loophole}`);
  assert.match(s2, /The profile is `cpr` with the application foundation/);

  const header = pinnedGuidanceHeader(guidance.version);
  assert.ok(constitution.includes(`${MARKER}\n${header}\n\n`), 'constitution.md carries exactly the header the sync script writes');
  assert.match(header, /^# Governing Mock2 guidance: \d+\.\d+\.\d+\n/);
  assert.match(header, /It does not supersede §2 above: the stack and the application foundation are a platform contract\./);
  assert.match(header, /New Dev Studio applications use profile `cpr` with the foundation/);
  assert.match(header, /no SQLite or other engine without the person's recorded request/);
  // The header's earlier boundary lines survive (upstream-guidance.test.js pins one of them).
  assert.match(header, /concrete identity, authorization, private-data and execution contracts remain binding/);
  // The pinned upstream bytes are unchanged and still follow the header.
  const canonical = guidance.files.find((f) => f.path === '.mock2/standards/constitution.md').content;
  assert.ok(constitution.includes(`${header}\n\n${canonical}\n<!-- END PINNED MOCK2 GUIDANCE -->\n`));
});

test('secrets and config elsewhere in the platform part agree with §2', () => {
  const p = flat(platformPart);
  assert.doesNotMatch(p, /Secrets\*\* live in a dedicated secrets manager/);
  assert.match(p, /\*\*Secrets\*\* are held encrypted in the database and delivered sealed by the platform \(§2 rule 6\)/);
  assert.match(p, /no secret in an env file or unit file \(§2 rule 6\)/);
  assert.match(p, /Object storage, embeddings and vector search come only through the application foundation's adapters \(§2\)/);
});

test('the build runner is prompted with §2 and the precedence line in every build mode and harness', () => {
  for (const buildMode of ['full', 'mvp', 'quick']) {
    for (const harness of ['proxypilot', 'copilot']) {
      const prompt = flat(buildRunnerSystemPrompt({ constitution, buildMode, harness }));
      assert.ok(prompt.includes('## 2. The stack and the application foundation'), `${buildMode}/${harness}: §2`);
      assert.ok(prompt.includes('It does not supersede §2 above'), `${buildMode}/${harness}: precedence line`);
      assert.ok(prompt.includes('Nothing in the repository can create the exception'), `${buildMode}/${harness}: exception rule`);
    }
  }
});

test('the build skill repeats the stack rules in short', () => {
  const build = JSON.parse(read('skills.json')).find((s) => s.name === 'build');
  const b = flat(build.body);
  assert.match(b, /on PostgreSQL \+ pgvector from the application foundation \(constitution §2\)/);
  assert.match(b, /no SQLite or other database engine unless your task quotes the person's recorded database exception/);
  assert.match(b, /never a fallback when the database is missing/);
  assert.match(b, /never an S3 SDK or embedding API in feature code/);
  assert.match(b, /no secrets in the repo or in env files/);
});

test('the seed README no longer contradicts itself about base-app', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /JSON store/);
  assert.doesNotMatch(readme, /A generated project starts from this tree/);
  assert.match(readme, /`base-app\/` — a \*\*reference implementation\*\*/);
  assert.match(readme, /It is \*\*not installed\*\* into projects/);
  assert.match(readme, /deliberately NOT what\ngets installed/);
  assert.match(readme, /## Stack and application foundation \(2026-10-24\)/);
});
