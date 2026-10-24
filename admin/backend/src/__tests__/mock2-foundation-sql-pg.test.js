// Application foundation — the host's SQL against a REAL PostgreSQL with
// pgvector (opt-in). Every script foundation-logic.js builds is sent to psql
// on stdin as the superuser — exactly how foundationPsql delivers it — into a
// database created with the contract's FOUNDATION_SCHEMA_SQL:
//   the sync (generation bump, upserts, stale-secret delete, NOTIFY payload),
//   literal escaping of hostile config, the job/index rows, poll, cancel, the
//   index promotion (refused while not ready — the whole transaction rolls
//   back), health and data-guard probes.
//
// Run with a throwaway container of the contract's image:
//   docker run -d --name fpg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=app --network none pgvector/pgvector:0.8.7-pg18
//   FOUNDATION_PG_CONTAINER=fpg node --test src/__tests__/mock2-foundation-sql-pg.test.js
// Skipped when FOUNDATION_PG_CONTAINER is unset.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { FOUNDATION_SCHEMA_SQL, STACK, sealForApp, openForApp, generateMasterKey, FOUNDATION_NOTIFY_CHANNEL } from '../mock2/foundation-contract.js';
import {
  buildSyncSql, buildJobInsertSql, buildJobPollSql, buildCancelJobSql, buildActiveIndexSql, buildHealthReadSql,
  promoteIndexStatements, buildGuardProbeSql, buildGuardRowsSql, parseGeneration, parseJsonRows, parseMarker, SQL_MARKERS, featureRowsFrom,
} from '../mock2/foundation-logic.js';

const CONTAINER = process.env.FOUNDATION_PG_CONTAINER;
const skip = !CONTAINER && 'set FOUNDATION_PG_CONTAINER to a pgvector/pgvector container (see the header)';

function psql(sql, { database = 'app' } = {}) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-U', 'postgres', '-d', database], { input: sql, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function q(sql) {
  const r = psql(`\\set ON_ERROR_STOP on\n${sql}`);
  assert.equal(r.code, 0, r.stderr);
  return parseJsonRows(r.stdout);
}

let ready = false;
function prepare() {
  if (ready) return;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' }).status === 0) break;
    spawnSync('sleep', ['1']);
  }
  psql(`DROP SCHEMA IF EXISTS mock2_foundation CASCADE;\nDROP TABLE IF EXISTS public.auth_connections;\nDO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${STACK.postgres.role}') THEN CREATE ROLE ${STACK.postgres.role} LOGIN; END IF; END $$;`);
  const r = psql(`\\set ON_ERROR_STOP on\n${FOUNDATION_SCHEMA_SQL}`);
  assert.equal(r.code, 0, r.stderr);
  ready = true;
}

const FEATURES = (storageConfig = {}, pending = null) => featureRowsFrom([
  { feature: 'storage', state: 'on', provider: 'external', config_json: JSON.stringify(storageConfig), pending_json: pending ? JSON.stringify(pending) : null, updated_at: 'x' },
  { feature: 'embeddings', state: 'off', provider: 'local', config_json: JSON.stringify({ model: 'BAAI/bge-small-en-v1.5', dimensions: 384 }), pending_json: null, updated_at: 'x' },
]);

test('sync: generation bumps by one per sync, rows upserted, stale secrets deleted, NOTIFY carries the generation', { skip }, () => {
  prepare();
  const key = generateMasterKey();
  const sealed = [{ name: 'storage.access_key_id', sealed: sealForApp(key, 'storage.access_key_id', 'AKIAONE') }, { name: 'embeddings.api_key', sealed: sealForApp(key, 'embeddings.api_key', 'sk-one') }];
  const first = psql(`LISTEN ${FOUNDATION_NOTIFY_CHANNEL};\n${buildSyncSql({ features: FEATURES({ bucket: 'b-1' }), sealed })}`);
  assert.equal(first.code, 0, first.stderr);
  const g1 = parseGeneration(first.stdout);
  assert.ok(Number.isInteger(g1));
  assert.match(first.stdout, new RegExp(`Asynchronous notification "${FOUNDATION_NOTIFY_CHANNEL}" with payload "${g1}"`));
  const second = psql(buildSyncSql({ features: FEATURES({ bucket: 'b-2' }), sealed: sealed.slice(0, 1) }));
  assert.equal(parseGeneration(second.stdout), g1 + 1);
  const features = q(`SELECT 'MF_JSON:' || json_build_object('feature', feature, 'state', state, 'provider', provider, 'config', config, 'generation', generation)::text FROM mock2_foundation.features ORDER BY feature;`);
  assert.deepEqual(features.map((f) => [f.feature, f.state, f.provider, f.generation]), [['embeddings', 'off', 'local', g1 + 1], ['storage', 'on', 'external', g1 + 1]]);
  assert.equal(features[1].config.bucket, 'b-2');
  const secrets = q(`SELECT 'MF_JSON:' || json_build_object('name', name, 'sealed', sealed)::text FROM mock2_foundation.secrets ORDER BY name;`);
  assert.deepEqual(secrets.map((s) => s.name), ['storage.access_key_id'], 'the removed secret is gone from the app DB');
  assert.equal(openForApp(key, 'storage.access_key_id', secrets[0].sealed), 'AKIAONE');
  const none = psql(buildSyncSql({ features: FEATURES(), sealed: [] }));
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual(q(`SELECT 'MF_JSON:' || json_build_object('n', count(*))::text FROM mock2_foundation.secrets;`), [{ n: 0 }]);
});

test('escaping: hostile config text round-trips exactly as data — quotes, backslashes, dollar tags, unicode', { skip }, () => {
  prepare();
  const evil = { prefix: "x'); DROP TABLE mock2_foundation.secrets; --", note: 'back\\slash \\x41 $mf$ $$ end', unicode: 'café ✓ 雪', newline: 'a\nb' };
  const r = psql(buildSyncSql({ features: FEATURES(evil, { provider: 'bundled', config: { quote: "it's" }, mode: 'copy' }), sealed: [] }));
  assert.equal(r.code, 0, r.stderr);
  const [row] = q(`SELECT 'MF_JSON:' || json_build_object('config', config, 'pending', pending)::text FROM mock2_foundation.features WHERE feature = 'storage';`);
  assert.deepEqual(row.config, evil);
  assert.deepEqual(row.pending, { provider: 'bundled', config: { quote: "it's" }, mode: 'copy' });
  assert.deepEqual(q(`SELECT 'MF_JSON:' || json_build_object('n', count(*))::text FROM mock2_foundation.secrets;`), [{ n: 0 }], 'the table still exists');
});

test('jobs and indexes: insert, poll, cancel; promotion refused while building (rolled back), applied once ready', { skip }, () => {
  prepare();
  q("INSERT INTO mock2_foundation.vector_indexes (id, provider, model, dimensions, metric, state, table_name, activated_at) VALUES ('ix_old0001', 'local', 'BAAI/bge-small-en-v1.5', 384, 'cosine', 'active', 'vec_ix_old0001', now()) ON CONFLICT DO NOTHING;");
  const active = parseJsonRows(psql(buildActiveIndexSql()).stdout);
  assert.deepEqual(active.map((a) => a.id), ['ix_old0001']);
  const ins = psql(buildJobInsertSql({ job: { id: 'fj_pgtest0001', kind: 'reembed', params: { source_index: 'ix_old0001', target_index: 'ix_new0001', note: "it's" } }, index: { id: 'ix_new0001', provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, metric: 'cosine' } }));
  assert.equal(ins.code, 0, ins.stderr);
  assert.equal(parseMarker(ins.stdout, SQL_MARKERS.ok)[0], 'inserted');
  const polled = parseJsonRows(psql(buildJobPollSql({ jobId: 'fj_pgtest0001', indexId: 'ix_new0001' })).stdout);
  assert.deepEqual(polled.map((p) => [p.type, p.state]), [['job', 'queued'], ['index', 'building']]);
  // Not ready: the promotion transaction fails as a whole — features unchanged, no index moved.
  const before = parseGeneration(psql(buildSyncSql({ features: FEATURES({ bucket: 'keep' }), sealed: [] })).stdout);
  const refused = psql(buildSyncSql({ features: FEATURES({ bucket: 'changed' }), sealed: [], statements: promoteIndexStatements('ix_new0001') }));
  assert.notEqual(refused.code, 0);
  assert.equal(parseGeneration(refused.stdout), null);
  assert.match(refused.stderr, /index ix_new0001 is not ready/);
  assert.deepEqual(parseJsonRows(psql(buildActiveIndexSql()).stdout).map((a) => a.id), ['ix_old0001']);
  const [still] = q(`SELECT 'MF_JSON:' || json_build_object('bucket', config->>'bucket', 'g', (SELECT value #>> '{}' FROM mock2_foundation.meta WHERE key = 'generation'))::text FROM mock2_foundation.features WHERE feature = 'storage';`);
  assert.deepEqual(still, { bucket: 'keep', g: String(before) });
  // Ready: one transaction retires the old index, activates the new one, switches the feature.
  q("UPDATE mock2_foundation.vector_indexes SET state = 'ready' WHERE id = 'ix_new0001';");
  const promoted = psql(buildSyncSql({ features: FEATURES({ bucket: 'changed' }), sealed: [], statements: promoteIndexStatements('ix_new0001') }));
  assert.equal(promoted.code, 0, promoted.stderr);
  assert.equal(parseGeneration(promoted.stdout), before + 1);
  const states = q(`SELECT 'MF_JSON:' || json_build_object('id', id, 'state', state, 'retired', retired_at IS NOT NULL)::text FROM mock2_foundation.vector_indexes ORDER BY id;`);
  assert.deepEqual(states.map((s) => [s.id, s.state]), [['ix_new0001', 'active'], ['ix_old0001', 'retired']]);
  // Cancel: only an active job; the target index of a cancelled reembed is failed.
  psql(buildJobInsertSql({ job: { id: 'fj_pgtest0002', kind: 'reembed' }, index: { id: 'ix_new0002', provider: 'openai', model: 'm', dimensions: 8, metric: 'l2' } }));
  const c = psql(buildCancelJobSql({ jobId: 'fj_pgtest0002', indexId: 'ix_new0002' }));
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(parseJsonRows(psql(buildJobPollSql({ jobId: 'fj_pgtest0002', indexId: 'ix_new0002' })).stdout).map((p) => p.state), ['cancelled', 'failed']);
});

test('health read and the data-guard probes', { skip }, () => {
  prepare();
  q(`INSERT INTO mock2_foundation.health (component, status, detail) VALUES ('database', 'ready', '{"latency_ms":3}') ON CONFLICT (component) DO UPDATE SET status = EXCLUDED.status;`);
  const h = parseJsonRows(psql(buildHealthReadSql()).stdout);
  assert.deepEqual(h.map((x) => [x.component, x.status, x.detail.latency_ms]), [['database', 'ready', 3]]);
  const guard = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext' };
  assert.deepEqual(parseJsonRows(psql(buildGuardProbeSql(guard)).stdout), [{ exists: false }]);
  q('CREATE TABLE public.auth_connections (id serial, secret_ciphertext text);');
  assert.deepEqual(parseJsonRows(psql(buildGuardProbeSql(guard)).stdout), [{ exists: true }]);
  assert.deepEqual(parseJsonRows(psql(buildGuardRowsSql(guard)).stdout), [{ rows: false }]);
  q("INSERT INTO public.auth_connections (secret_ciphertext) VALUES ('');");
  assert.deepEqual(parseJsonRows(psql(buildGuardRowsSql(guard)).stdout), [{ rows: false }], 'an empty secret is not a stored secret');
  q("INSERT INTO public.auth_connections (secret_ciphertext) VALUES ('abc');");
  assert.deepEqual(parseJsonRows(psql(buildGuardRowsSql(guard)).stdout), [{ rows: true }]);
});
