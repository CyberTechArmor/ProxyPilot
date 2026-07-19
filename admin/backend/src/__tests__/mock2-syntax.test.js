// Syntax smoke test: every mock2 source file (plus the entry) must PARSE as
// ESM. The unit suite deliberately never imports native-backed modules
// (routes.js → db.js → better-sqlite3), which is exactly how a duplicate
// import binding in routes.js once shipped: a boot-time SyntaxError that
// unmounted the whole module while 900+ tests stayed green. `node --check`
// with the package's "type": "module" context catches that class cold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '../..');
const mock2Dir = path.resolve(here, '../mock2');

test('every mock2 source file (and src/index.js) parses as ESM', () => {
  const files = readdirSync(mock2Dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('src/mock2', f));
  files.push('src/index.js');
  const bad = [];
  for (const rel of files) {
    try {
      execFileSync(process.execPath, ['--check', rel], { cwd: backendRoot, stdio: 'pipe' });
    } catch (err) {
      bad.push(`${rel}: ${String(err.stderr || err.message).split('\n').slice(-3).join(' ').trim()}`);
    }
  }
  assert.deepEqual(bad, [], `files with syntax errors:\n${bad.join('\n')}`);
});
