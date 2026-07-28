// CONTAINER FILE WRITES — the payload must arrive intact.
//
// Project 44's `src/platform/schema.ts` was found as FOUR BYTES: 8a 6a 68 ae.
// That is exactly `printf 'import' | base64 -d` — the opening word of the file
// it should have contained. The content had been base64-decoded TWICE: once on
// the host, then again by the script inside the container, which consumed the
// leading run of base64-legal characters ("import"), wrote those four bytes,
// and errored on the first space.
//
// A load-bearing platform file was destroyed in a live project by the upgrade
// path meant to keep it current, and a later build spent turns discovering it
// and restoring it from git. Both gates that caught it — typecheck ("File
// appears to be binary") and platform-intact ("no longer exports legalPages")
// — were reporting a defect the platform had committed.
//
// So this file tests the WRITE ITSELF, end to end, against a stub `incus` that
// really runs the script and really writes the file. Asserting the shape of the
// command string would have passed on the broken version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MOCK2_DIR = fileURLToPath(new URL('../mock2/', import.meta.url));

// A stub `incus` that behaves like the real one for `incus exec <name> -- sh -c <script>`:
// it runs the script with the SAME stdin, in a directory standing in for the
// container's filesystem. Everything this test proves rests on it doing exactly
// that and nothing helpful.
function stubIncus(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  // The scripts address the container by ABSOLUTE path (/srv/app/...), so the
  // stub rewrites that prefix into the fake root — otherwise every write would
  // silently target the real filesystem and the test would pass by reading the
  // file it seeded itself. (It did, the first time this was written.)
  const script = `#!/bin/sh
# argv: exec <container> -- sh -c <script>   (or: exec <container> -- sh)
shift 2            # drop "exec" and the container name
[ "$1" = "--" ] && shift
[ "$1" = "sh" ] && shift
FS="${root}/fs"
if [ "$1" = "-c" ]; then
  shift
  exec sh -c "$(printf '%s' "$1" | sed "s#/srv/app#$FS/srv/app#g")"
fi
# The stdin form: the script itself arrives on stdin.
exec sh -c "$(cat | sed "s#/srv/app#$FS/srv/app#g")"
`;
  writeFileSync(join(bin, 'incus'), script);
  chmodSync(join(bin, 'incus'), 0o755);
  mkdirSync(join(root, 'fs', 'srv', 'app', 'state'), { recursive: true });
  return bin;
}

test('a file written into a container arrives byte for byte', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pp-cwrite-'));
  const prevPath = process.env.PATH;
  process.env.PATH = `${stubIncus(root)}:${prevPath}`;
  t.after(() => { process.env.PATH = prevPath; rmSync(root, { recursive: true, force: true }); });

  // design-findings.js is the writer this suite can actually import (host.js
  // only, no better-sqlite3). It shares the exact helper shape the corrupting
  // upgrade path used, so proving this one proves the pattern.
  const { markDesignFindingsBriefed } = await import('../mock2/design-findings.js');
  const { renderFindingsLedger, mergeFindings, DESIGN_FINDINGS_PATH } = await import('../mock2/design-findings-logic.js');

  // Seed a ledger with a finding whose text starts with a base64-legal word —
  // the same trap that turned schema.ts into four bytes.
  const ledger = mergeFindings({ findings: [] }, [
    { screen: '/notes', severity: 'high', issue: 'import the notes list properly', fix: 'do it' },
  ], { cycleId: 1 });
  const onDisk = join(root, 'fs', 'srv', 'app', DESIGN_FINDINGS_PATH);
  mkdirSync(path.dirname(onDisk), { recursive: true });
  writeFileSync(onDisk, renderFindingsLedger(ledger));

  const project = { id: 44, container_name: 'n9', lifecycle: 'active' };
  const key = ledger.findings[0].key;
  assert.equal(await markDesignFindingsBriefed(project, [key]), true, 'the write must report success');

  const after = readFileSync(onDisk, 'utf8');
  // The failure this exists for: 4 bytes of binary instead of a file.
  assert.ok(after.length > 100, `the file was truncated to ${after.length} bytes — that is the double-decode bug`);
  assert.doesNotMatch(after, /�/, 'no replacement characters — the bytes survived');
  const parsed = JSON.parse(after);
  assert.equal(parsed.findings[0].buildsBriefed, 1, 'and it is the file we meant to write');
  assert.equal(parsed.findings[0].issue, 'import the notes list properly');
});

test('the exact four bytes: what a double decode produces', async (t) => {
  // Documented as an executable fact rather than a comment, because the next
  // person to see 8a 6a 68 ae in a project should be able to search for it.
  const root = mkdtempSync(join(tmpdir(), 'pp-cwrite2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { execFileSync } = await import('node:child_process');
  // base64 exits non-zero on the invalid tail — the four bytes are written
  // BEFORE it errors, which is exactly why the corrupted file existed at all.
  const out = execFileSync('sh', ['-c', "printf 'import' | base64 -d 2>/dev/null || true"], { encoding: 'buffer' });
  assert.equal([...out].map((b) => b.toString(16).padStart(2, '0')).join(' '), '8a 6a 68 ae',
    "these are the bytes project 44's schema.ts was reduced to");
});

test('RATCHET: no writer decodes the payload on the host AND in the container', () => {
  // The shape that caused it: `printf b64 | base64 -d | incus exec … sh -c
  // "<script that also runs base64 -d>"`. The correct shape passes the ENCODED
  // text through `{ input: b64(...) }` and lets the container decode once.
  //
  // Scanned across every mock2 module because this bug was copied: one helper
  // had it, and three later writers were written by looking at that helper.
  const bad = [];
  for (const name of readdirSync(MOCK2_DIR).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(MOCK2_DIR, name), 'utf8');
    // A host-side decode piped into `incus exec` whose command ALSO decodes.
    for (const m of src.matchAll(/base64 -d \| incus exec[^`]*/g)) {
      const cmd = m[0];
      // `sh -c "$(printf … base64 -d)"` decodes the SCRIPT, which is correct and
      // unrelated; the hazard is the script itself decoding stdin.
      const decodesStdinToo = /base64 -d > "\$d"|base64 -d > \$\{?d/.test(cmd)
        || /tar -xf -/.test(cmd) === false && /base64 -d/.test(cmd.replace(/\$\(printf[^)]*\)/g, ''));
      if (decodesStdinToo && /-- sh -c/.test(cmd)) {
        bad.push(`${name}: ${cmd.slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'a payload decoded twice arrives as a few bytes of garbage');
});

test('every stdin writer passes the payload ENCODED', () => {
  // The positive form of the rule, so a new writer copied from a good one stays
  // good: wherever a container script runs `base64 -d > "$d"`, the host call
  // that feeds it must supply `input: b64(...)` and must NOT pre-decode.
  const offenders = [];
  for (const name of readdirSync(MOCK2_DIR).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(MOCK2_DIR, name), 'utf8');
    if (!/base64 -d > "\$d"/.test(src)) continue;
    // Every sh(...) call in this file that targets `incus exec … sh -c` must
    // carry an input option rather than a host-side decode of the payload.
    for (const m of src.matchAll(/sh\(\s*`([^`]*incus exec[^`]*)`,\s*\{([^}]*)\}/g)) {
      const [, cmd, opts] = m;
      if (!/-- sh -c/.test(cmd)) continue;
      const hostDecodesPayload = /^[^|]*\|\s*base64 -d\s*\|\s*incus exec/.test(cmd.trim());
      if (hostDecodesPayload) offenders.push(`${name}: host-side decode before incus exec`);
      // `{ timeoutMs, input }` shorthand counts — concept.js has always used it.
      else if (!/\binput\b/.test(opts)) offenders.push(`${name}: no stdin payload for a script that reads stdin`);
    }
  }
  assert.deepEqual(offenders, []);
});
