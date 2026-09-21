// A scripted guest for the setup-engine suites: it understands the
// containment wrapper (guest-probes containedScript) and every deploy and
// verification script the executor sends, and answers from `state`.
//   state.ldaps      the app's LDAPS answer for the application-owned check
//   state.survivors  what the reaper reports (STALE_WRITERS)
//   state.fail       'migrate' makes the migration fail; 'build' the build
//   state.serves     false makes the health check fail
//   state.commit / state.buildId   what the guest reports as its revision
//                    (buildId defaults to the id the deploy stamped)
//   state.containment  'none' makes every contained script refuse (exit 97)
// Nothing here is a process: real-process containment lives in
// setup-deploy-closeout.test.js.
import assert from 'node:assert/strict';
import { getJob, listEvents } from '../../lib/setup-engine/store.js';

export const GUARD = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: 'dev-insecure-master-secret-change-me' };
export const CONTRACT = { hasContract: true, install: 'npm ci', migrate: 'npm run migrate', build: 'npm run build', start: 'npm run start' };
export const PARAMS = (extra = {}) => ({ container: 'pp-x', appDir: '/srv/app', webPort: 3000, environmentFile: '/etc/environment', contract: CONTRACT, secrets: { configs: [] }, guard: GUARD, ...extra });
export const LOGIN = { email: 'review@app.test', password: 'pw-secret-value-9f8e7d' };

export const unwrapContained = (raw) => { const m = String(raw).match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$T"/); return m ? Buffer.from(m[1], 'base64').toString('utf8') : String(raw); };
export const isContained = (raw) => /printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d > "\$T"/.test(String(raw));
export const jobIdOf = (raw) => (String(raw).match(/mock2_deploy_marker job=([A-Za-z0-9-]+)/) || [])[1] || 'adhoc';

export function scriptedGuest(state) {
  const calls = [];
  const unwrap = (raw) => { const m = String(raw).match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$T"/); return m ? Buffer.from(m[1], 'base64').toString('utf8') : String(raw); };
  const jobIdOf = (raw) => (String(raw).match(/mock2_deploy_marker job=([A-Za-z0-9-]+)/) || [])[1] || 'adhoc';
  return {
    calls,
    guest: async (container, raw) => {
      const s = unwrap(raw);
      const id = jobIdOf(raw);
      const rec = (phase) => calls.push({ container, phase, id, raw, script: s });
      if (state.containment === 'none' && isContained(raw)) { rec('refused'); return { code: 97, stdout: '', stderr: 'CONTAINMENT:none\n' }; }
      if (/REV_COMMIT:/.test(s)) { rec('read_revision'); return { code: 0, stdout: `REV_COMMIT:${state.commit || 'd'.repeat(40)}\nREV_BUILD:${state.buildId || state.stampedBuildId || 'x'}\n` }; }
      if (/STALE_WRITERS:/.test(s)) { rec('reap'); return { code: 0, stdout: `STALE_WRITERS:${state.survivors ?? 0}\n` }; }
      if (/PP_CRED_EOF/.test(s)) {
        rec('credential_use');
        assert.ok(s.includes(LOGIN.password), 'the login reaches the guest script (in memory, never a row)');
        const bodies = {
          current: 'SIGNIN:200\n{"configured":true,"masterKey":"current","masterKeyInventory":{"total":2,"current":2,"legacy":0,"unreadable":0,"complete":true}}\nLDAPS:200\n',
          legacy: 'SIGNIN:200\n{"configured":true,"masterKey":"legacy","masterKeyInventory":{"total":2,"current":1,"legacy":1,"unreadable":0,"complete":false}}\nLDAPS:200\n',
          unreadable: 'SIGNIN:200\n{"configured":true,"masterKey":"unreadable","masterKeyInventory":{"total":1,"current":0,"legacy":0,"unreadable":1,"complete":false}}\nLDAPS:200\n',
          none: 'SIGNIN:200\n{"configured":false,"masterKey":"none","masterKeyInventory":{"total":0,"current":0,"legacy":0,"unreadable":0,"complete":true}}\nLDAPS:200\n',
          down: 'SIGNIN:000\n',
          nosettings: 'SIGNIN:200\nLDAPS:000\n',
        };
        return { code: 0, stdout: bodies[state.ldaps || 'current'] };
      }
      if (/DBDUMP:/.test(s)) { rec('protect'); state.protects = [...(state.protects || []), id]; return { code: 0, stdout: state.protectOut ?? `DBDUMP:/var/backups/proxypilot-db/app-pre-deploy-${id}.sql:100:${'a'.repeat(64)}\nUNITCOPY:/etc/systemd/system/mock2-dev.service.pre-${id}\nENVCOPY:/etc/environment.pre-${id}\nCOMMIT:${state.commit || 'd'.repeat(40)}\n` }; }
      if (/MIGRATE_SCRIPT:/.test(s)) { rec('migrate_class'); return { code: 0, stdout: state.migrateClassOut ?? 'MIGRATE_SCRIPT:"migrate": "node scripts/migrate.mjs"\nMIGRATIONS_DIR:yes\n' }; }
      if (/mock2\.yaml/.test(s)) { rec('contract'); return { code: 0, stdout: 'run:\n  install: npm ci\n  migrate: npm run migrate\n  build: npm run build\n  start: npm run start\n' }; }
      if (/MOCK2_INSTALL_FRESH/.test(s)) { rec('install_fresh'); return { code: 0, stdout: 'MOCK2_INSTALL_FRESH\n' }; }
      if (/playwright\.config/.test(s)) { rec('e2e'); return { code: 1, stdout: '' }; }
      if (/MOCK2_RETROFIT_DONE/.test(s)) { rec('pwa'); return { code: 0, stdout: 'MOCK2_RETROFIT_DONE\n' }; }
      if (/\/etc\/systemd\/system\/mock2-dev\.service/.test(s)) { rec('unit_swap'); state.active = true; return { code: 0, stdout: '' }; }
      if (/journalctl/.test(s)) { rec('health'); return { code: 0, stdout: state.serves === false ? 'MOCK2_NOT_SERVING (last http_code: 000)\n' : 'MOCK2_SERVING (302)\n' }; }
      if (/MOCK2_SERVING/.test(s) && /systemctl start/.test(s)) { rec('restart'); state.active = true; return { code: 0, stdout: 'MOCK2_SERVING (200)\n' }; }
      if (/systemctl stop mock2-dev\.service/.test(s)) { rec('stop'); state.active = false; if (state.hooks?.stop) await state.hooks.stop(); return { code: 0, stdout: '' }; }
      if (/MARKER (OK|MISSING)/.test(s)) { rec('markers'); return { code: 0, stdout: 'MARKER OK AUTH_MASTER_SECRET\n' }; }
      if (/environment\.mock2-tmp/.test(s)) { rec('env_write'); return { code: 0, stdout: '' }; }
      if (/^cat \/etc\/environment/m.test(s)) { rec('env_read'); return { code: 0, stdout: 'AUTH_JWT_SECRET=x\nAUTH_MASTER_SECRET=k\n' }; }
      if (/PGPASSFILE|psql/.test(s)) { rec('data_probe'); return { code: 0, stdout: 'PROBE:ok\nTARGET:127.0.0.1:5432/app schema=public\nRLS:off\n' }; }
      if (/AUTH_MASTER_SECRET=/.test(s) && /sed -n/.test(s)) { rec('active_key'); return { code: 0, stdout: 'k\n' }; }
      if (/\/api\/health/.test(s)) { rec('health_check'); return { code: 0, stdout: 'ROOT:302\nHEALTH:200\nLOGIN:200\n' }; }
      if (/UNIT_LOADED/.test(s)) { rec('unit_status'); return { code: 0, stdout: `UNIT_LOADED:yes\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:${state.active === false ? 'inactive' : 'active'}\n` }; }
      if (/START_RC/.test(s)) { rec('start_unit'); state.active = true; return { code: 0, stdout: 'START_RC:0\nUNIT_ACTIVE:active\n' }; }
      if (/PORT_SERVING/.test(s)) { rec('port'); return { code: 0, stdout: state.active === false ? 'PORT_NOT_SERVING:000\n' : 'PORT_SERVING:302\n' }; }
      if (/npm run migrate/.test(s)) { rec('migrate'); if (state.hooks?.migrate) await state.hooks.migrate(); return state.fail === 'migrate' ? { code: 1, stdout: 'apply 0002_add_col.sql\n', stderr: 'migration 0002_add_col.sql failed: relation exists' } : { code: 0, stdout: 'skip 0001 (already applied)\napply 0002\n' }; }
      if (/npm run build/.test(s)) { rec('build'); return state.fail === 'build' ? { code: 1, stdout: '', stderr: 'vite: out of memory' } : { code: 0, stdout: '' }; }
      if (/npm ci/.test(s)) { rec('install'); return { code: 0, stdout: '' }; }
      if (/build-id|sw\.js|MOCK2_BUILD_ID/.test(s)) { rec('stamp'); const m = s.match(/printf '%s\\n' '(\d{14}-[a-z0-9]+)' > public\/build-id\.txt/); if (m) state.stampedBuildId = m[1]; return { code: 0, stdout: `MOCK2_BUILD_ID:${state.stampedBuildId || 'x'}\n` }; }
      rec('other'); return { code: 1, stdout: '', stderr: `unexpected: ${s.slice(0, 60)}` };
    },
  };
}

export function noSecretIn(d, jobIds) {
  for (const id of jobIds) {
    const row = getJob(d, id);
    const dump = JSON.stringify(row) + JSON.stringify(listEvents(d, id));
    assert.equal(dump.includes(LOGIN.password), false, `review password leaked into job ${id}`);
    assert.equal(dump.includes(LOGIN.email), false, `review email leaked into job ${id}`);
  }
}

