import { createHash } from 'node:crypto';
import { FIXTURE_MODES } from './operational-recovery-schema.js';

// A7 decision 4: the demo's fixture mode for a practice run, chosen from the
// dashboard. The one write path into the demo guest the backend has: a fixed
// argv (`incus exec pp-fractionate-demo -- sh -c <constant>`) with the small,
// non-secret document on stdin, then a byte-exact read-back. No caller data
// reaches the argv; the mode is one of FIXTURE_MODES and injection is always
// off. Fixture modes apply only after the synthetic account's correct password
// and are never counted in the demo's shared sign-in limit
// (admin/frontend/demo/server.mjs). The same file and format as the host tool
// scripts/a4-fixture-account.py set-mode.
export const DEMO_INSTANCE = 'pp-fractionate-demo';
export const DEMO_FIXTURE = '/opt/app/demo/a5-fixture.json';
// Written through a temporary file in the same directory and renamed, so the
// demo never reads half a document (it re-reads the file when its mtime changes).
const WRITE = `umask 022; t=$(mktemp /opt/app/demo/.a5-fixture.XXXXXX) && cat > "$t" && chmod 0644 "$t" && mv -f "$t" ${DEMO_FIXTURE}`;
const coded = (code) => { const error = new Error(code); error.code = code; return error; };

export function fixtureDocument(mode) {
  if (!FIXTURE_MODES.includes(mode)) throw coded('INVALID_FIXTURE_MODE');
  return `${JSON.stringify({ v: 1, mode, injection: false })}\n`;
}

// `runHostCapture(bin, args, { input, timeoutMs })` is lib/lxc-zip.js's (host
// namespace aware); tests inject a recorder.
export function createDemoFixtureWriter({ runHostCapture, instance = DEMO_INSTANCE, timeoutMs = 30_000 } = {}) {
  if (typeof runHostCapture !== 'function' || instance !== DEMO_INSTANCE) throw coded('FIXTURE_WRITER_INVALID');
  return {
    async apply(mode) {
      const document = fixtureDocument(mode);
      const write = await runHostCapture('incus', ['exec', instance, '--', 'sh', '-c', WRITE], { input: document, timeoutMs });
      if (write?.status !== 0 || write.timedOut) throw coded('FIXTURE_WRITE_FAILED');
      const read = await runHostCapture('incus', ['exec', instance, '--', 'sha256sum', DEMO_FIXTURE], { timeoutMs });
      const sum = String(read?.stdout ?? '').split(/\s+/)[0];
      if (read?.status !== 0 || sum !== createHash('sha256').update(document).digest('hex')) throw coded('FIXTURE_READBACK_FAILED');
      return { mode, sha256: sum };
    },
  };
}
