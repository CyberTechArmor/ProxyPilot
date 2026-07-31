// Machine check (LEARNINGS row 149): no RAW control bytes in backend source.
//
// Four times now, a control-character class meant as /[\u0000-\u001f\u007f]/
// has been emitted into source as the LITERAL bytes (NUL, 0x1f, 0x7f) instead
// of the escape sequences. V8 happens to parse it, so it runs — but the file
// reads as binary to grep/diff tooling, the class silently narrows if an
// editor "cleans" it, and the next copy-paste propagates it. Escapes are the
// rule; this test is the ratchet that keeps them.
//
// Allowed: tab (0x09), LF (0x0a), CR (0x0d). Everything else below 0x20, and
// DEL (0x7f), fails with file + offset so the fix is a one-line patch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_EXTENSIONS = new Set(['.js', '.jsx', '.md', '.json', '.sql', '.yml', '.yaml']);
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('backend source contains no raw control bytes (escaped forms only)', () => {
  const offenders = [];
  for (const file of walk(SRC_ROOT)) {
    const dot = file.lastIndexOf('.');
    if (dot === -1 || !SCAN_EXTENSIONS.has(file.slice(dot))) continue;
    const data = readFileSync(file);
    for (let i = 0; i < data.length; i += 1) {
      const b = data[i];
      if ((b < 0x20 && !ALLOWED.has(b)) || b === 0x7f) {
        offenders.push(`${relative(SRC_ROOT, file)} @ byte ${i} (0x${b.toString(16)})`);
        break; // one report per file is enough to fail and locate
      }
    }
  }
  assert.deepEqual(offenders, [], `Raw control bytes in source (write \\u escapes instead): ${offenders.join('; ')}`);
});
