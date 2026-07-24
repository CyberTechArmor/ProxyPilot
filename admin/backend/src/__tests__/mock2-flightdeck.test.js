// Flightdeck IDE file API — the pure decision layer (flightdeck-logic.js): the
// path-traversal guard every endpoint funnels through, the `find` listing parse
// + tree assembly, noise filtering, language detection, and the binary
// heuristic. Stub-first (risk R9): imports ONLY the native-free logic module.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeRelPath, isNoiseDir, languageForPath, parseFindTypeOutput, buildFileTree,
  buildFindCommand, isProbablyBinary, FLIGHTDECK_NOISE_DIRS,
} from '../mock2/flightdeck-logic.js';

test('safeRelPath: rejects traversal / absolute; normalizes; root is "."', () => {
  assert.equal(safeRelPath('src/app.js'), 'src/app.js');
  assert.equal(safeRelPath('./src/./app.js'), 'src/app.js');
  assert.equal(safeRelPath('src//nested///x.js'), 'src/nested/x.js');
  assert.equal(safeRelPath(''), '.');
  assert.equal(safeRelPath('.'), '.');
  // Unsafe → null
  assert.equal(safeRelPath('/etc/passwd'), null);
  assert.equal(safeRelPath('../secret'), null);
  assert.equal(safeRelPath('src/../../etc'), null);
  assert.equal(safeRelPath('C:\\win'), null);
  assert.equal(safeRelPath('a\0b'), null);
});

test('languageForPath: extension → language id; Dockerfile special-cased; unknown → text', () => {
  assert.equal(languageForPath('src/App.tsx'), 'typescript');
  assert.equal(languageForPath('main.py'), 'python');
  assert.equal(languageForPath('styles.css'), 'css');
  assert.equal(languageForPath('README.md'), 'markdown');
  assert.equal(languageForPath('Dockerfile'), 'dockerfile');
  assert.equal(languageForPath('data.bin'), 'text');
  assert.equal(languageForPath('noext'), 'text');
});

test('isNoiseDir: build/vendor dirs are noise', () => {
  for (const d of FLIGHTDECK_NOISE_DIRS) assert.equal(isNoiseDir(d), true);
  assert.equal(isNoiseDir('src'), false);
});

test('parseFindTypeOutput: strips ./, marks dirs, drops unsafe entries', () => {
  const out = ['D\t./src', 'F\t./src/app.js', 'F\t./package.json', 'D\t./node_modules', 'F\t./../evil', 'junk line'].join('\n');
  const { paths, dirs } = parseFindTypeOutput(out);
  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('src/app.js'));
  assert.ok(paths.includes('package.json'));
  assert.ok(dirs.has('src'));
  assert.ok(dirs.has('node_modules'));
  assert.ok(!paths.some((p) => p.includes('evil'))); // traversal dropped
});

test('buildFileTree: nests files under dirs, dirs-first sort, noise dirs muted', () => {
  const { paths, dirs } = parseFindTypeOutput([
    'D\tsrc', 'F\tsrc/app.js', 'F\tsrc/index.js', 'D\tsrc/lib', 'F\tsrc/lib/util.js',
    'F\tpackage.json', 'D\tnode_modules',
  ].join('\n'));
  const tree = buildFileTree(paths, { dirs });
  // Top level: src (dir) before package.json (file); node_modules present + muted.
  const names = tree.map((n) => n.name);
  assert.deepEqual(names, ['node_modules', 'src', 'package.json']); // dirs first, alpha
  const src = tree.find((n) => n.name === 'src');
  assert.equal(src.type, 'dir');
  const libChildNames = src.children.map((c) => c.name);
  assert.deepEqual(libChildNames, ['lib', 'app.js', 'index.js']);
  assert.equal(tree.find((n) => n.name === 'node_modules').muted, true);
  assert.equal(src.muted, false);
});

test('buildFileTree: implied intermediate dirs are created', () => {
  const tree = buildFileTree(['a/b/c.js'], { dirs: new Set() });
  assert.equal(tree[0].name, 'a');
  assert.equal(tree[0].children[0].name, 'b');
  assert.equal(tree[0].children[0].children[0].name, 'c.js');
});

test('buildFindCommand: bounded depth, excludes noise contents, typed marker passes', () => {
  const cmd = buildFindCommand({ maxDepth: 8 });
  assert.match(cmd, /find \. -maxdepth 8/);
  assert.match(cmd, /-not -path '\*\/node_modules\/\*'/);
  assert.match(cmd, /-type d/);
  assert.match(cmd, /-type f/);
  assert.match(cmd, /D\\t/);
  assert.match(cmd, /F\\t/);
});

test('isProbablyBinary: NUL/control-heavy → binary; text → not', () => {
  assert.equal(isProbablyBinary('const x = 1;\nfunction y() {}\n'), false);
  assert.equal(isProbablyBinary('has a \0 nul'), true);
  assert.equal(isProbablyBinary(''), false);
  assert.equal(isProbablyBinary('\x01\x02\x03\x04\x05\x06\x07\x08'), true);
});
