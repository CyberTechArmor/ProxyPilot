// Setup engine — the INPUT store for a guest setup's init script (A-17.7).
//
// An operator's init script may carry anything — an API token, a database
// password — so it never becomes a job row, an event or a log line (the
// engine redacts what it recognises, and refuses a plan that carries a
// value it recognises; a script is neither). It is written as a file next
// to the database, `<db dir>/setup-inputs/<ref>.init.sh`, mode 0600 in a
// 0700 directory, by the backend that received it; the plan carries the
// reference, the sha256 and the byte count; the executor (the host runner,
// or the backend in-process) reads the file by that reference, verifies the
// digest before it issues anything, and consumes (unlinks) the file when the
// init phase completes. Both sides derive the directory from the database
// path they opened — the same directory, bind-mounted into the container.
// A file nobody consumed (a job that never reached its init phase and was
// never retried) is swept after a day.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INPUT_REF_RE } from './setup-logic.js';

export const INPUTS_DIR_NAME = 'setup-inputs';
export const INPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const INPUT_MAX_BYTES = 1 << 20;

export function setupInputsDir(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') throw new Error('the inputs directory is derived from the database path');
  return join(dirname(dbPath), INPUTS_DIR_NAME);
}

export function sha256Of(content) { return createHash('sha256').update(content).digest('hex'); }

function fileOf(dir, ref) {
  const r = String(ref || '');
  if (!INPUT_REF_RE.test(r)) throw new Error('an input reference is a plain identifier');
  return join(dir, `${r}.init.sh`);
}

// writeInitScriptInput(dir, content, { ref }) → { ref, sha256, bytes }: the
// reference the plan carries. Never overwrites: a reference is used once.
export function writeInitScriptInput(dir, content, { ref = randomUUID() } = {}) {
  const buf = Buffer.from(String(content), 'utf8');
  if (!buf.length) throw new Error('an empty init script is not written');
  if (buf.length > INPUT_MAX_BYTES) throw new Error(`the init script is larger than ${INPUT_MAX_BYTES} bytes`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const path = fileOf(dir, ref);
  writeFileSync(path, buf, { mode: 0o600, flag: 'wx' });
  return { ref: String(ref), sha256: sha256Of(buf), bytes: buf.length };
}

// readInitScriptInput(dir, ref) → { content, sha256, bytes } | null.
export function readInitScriptInput(dir, ref) {
  let buf;
  try { buf = readFileSync(fileOf(dir, ref)); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  return { content: buf.toString('utf8'), sha256: sha256Of(buf), bytes: buf.length };
}

// consumeInitScriptInput(dir, ref) → true when a file was removed.
export function consumeInitScriptInput(dir, ref) {
  try { unlinkSync(fileOf(dir, ref)); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
}

// sweepSetupInputs(dir, { maxAgeMs, nowMs }) → the references removed.
export function sweepSetupInputs(dir, { maxAgeMs = INPUT_MAX_AGE_MS, nowMs = Date.now() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  const removed = [];
  for (const n of names) {
    const m = n.match(/^([A-Za-z0-9-]{1,64})\.init\.sh$/);
    if (!m) continue;
    try {
      const st = statSync(join(dir, n));
      if (nowMs - st.mtimeMs >= maxAgeMs) { unlinkSync(join(dir, n)); removed.push(m[1]); }
    } catch { /* raced with a consume */ }
  }
  return removed;
}
