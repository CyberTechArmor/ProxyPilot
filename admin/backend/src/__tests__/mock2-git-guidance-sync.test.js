import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { buildPinnedGuidance } from '../../../../scripts/sync-mock2-guidance.mjs';

const prefix = 'core/mock2/templates/repo/';
const entry = prefix + '.mock2/bin/git-readiness.mjs';
const helper = prefix + '.mock2/bin/git-readiness-core.mjs';
function releaseFixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(),'pp-canonical-git-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const content = {
    'core/claude/CLAUDE.md':'# Constitution\n',
    ...Object.fromEntries(['CPR-v1.1-current.md','Relay-Recording.md','Universal-Integration.md','Universal-Integration-New-App-Prompt.md','Universal-Integration-Existing-App-Prompt.md','stack.versions.json'].map(name=>['core/cpr/'+name,'fixture\n'])),
    'core/claude/rules/mock2-git-readiness.md':'# Readiness rule\n',
    [prefix+'.mock2/git-readiness.md']:'# Git readiness guide\n',
    [entry]:"export {inspect} from './git-readiness-core.mjs';\n",
    [helper]:"import {resolve} from 'node:path';\nexport const inspect = resolve;\n",
    ...overrides,
  };
  const files = Object.entries(content).map(([src,value])=>{
    mkdirSync(dirname(join(root,src)),{recursive:true}); writeFileSync(join(root,src),value);
    return {src,sha256:createHash('sha256').update(value).digest('hex'),bytes:Buffer.byteLength(value)};
  });
  const release={name:'mock2-core',version:'1.35.0',updated:'2026-10-22',files};
  writeFileSync(join(root,'release.json'),JSON.stringify(release));
  return {root,release};
}

test('Git readiness adoption keeps only its hash-verified local runtime closure', t=>{
  const {root}=releaseFixture(t,{[entry]:"import {\n inspect\n} from './git-readiness-core.mjs';\nexport { inspect };\n"});
  const bundle=buildPinnedGuidance(root);
  assert.deepEqual(bundle.runtime_files.map(f=>f.path).sort(),['.mock2/bin/git-readiness-core.mjs','.mock2/bin/git-readiness.mjs','.mock2/git-readiness.md']);
  assert.equal(bundle.runtime_scope,'git-readiness-local-inspection');
  assert.ok(!bundle.runtime_files.some(f=>/project-setup|relay|flightdeck/.test(f.path)));
});

test('Git readiness adoption refuses a missing import, hash tampering and incomplete slice', t=>{
  const fixture=releaseFixture(t);
  const releasePath=join(fixture.root,'release.json');
  fixture.release.files=fixture.release.files.filter(f=>f.src!==helper);
  writeFileSync(releasePath,JSON.stringify(fixture.release));
  assert.throws(()=>buildPinnedGuidance(fixture.root),/Unsupported Git readiness dependency/);
  const tampered=releaseFixture(t);
  writeFileSync(join(tampered.root,helper),'changed');
  assert.throws(()=>buildPinnedGuidance(tampered.root),/hash\/size mismatch/);
  const incomplete=releaseFixture(t);
  incomplete.release.files=incomplete.release.files.filter(f=>f.src!==entry);
  writeFileSync(join(incomplete.root,'release.json'),JSON.stringify(incomplete.release));
  assert.throws(()=>buildPinnedGuidance(incomplete.root),/Incomplete canonical Git readiness slice/);
});

test('canonical source aliases deduplicate while conflicting release identities are refused', t=>{
  const {root,release}=releaseFixture(t);
  release.files.push({...release.files.find(f=>f.src===helper),dest:'~/.mock2/bin/git-readiness-core.mjs'});
  writeFileSync(join(root,'release.json'),JSON.stringify(release));
  assert.equal(buildPinnedGuidance(root).runtime_files.filter(f=>f.source===helper).length,1);
  release.files.at(-1).sha256='0'.repeat(64);
  writeFileSync(join(root,'release.json'),JSON.stringify(release));
  assert.throws(()=>buildPinnedGuidance(root),/Conflicting release file identity/);
});

test('same-line imports and re-exports retain the full allowed dependency closure', t=>{
  for (const statement of [
    "import 'node:fs'; import './git-readiness-core.mjs';\n",
    "export const ready=true; export * from './git-readiness-core.mjs';\n",
  ]) {
    const {root}=releaseFixture(t,{[entry]:statement});
    assert.ok(buildPinnedGuidance(root).runtime_files.some(f=>f.source===helper));
  }
});

test('same-line disallowed imports and unrecognized declaration formatting are refused', t=>{
  const disallowed=releaseFixture(t,{[entry]:"import 'node:fs'; import './project-setup.mjs';\n"});
  assert.throws(()=>buildPinnedGuidance(disallowed.root),/Unsupported Git readiness dependency/);
  for (const statement of [
    "import /* reviewed */ './git-readiness-core.mjs';\n",
    "import{inspect}from'./git-readiness-core.mjs';\n",
  ]) {
    const {root}=releaseFixture(t,{[entry]:statement});
    assert.throws(()=>buildPinnedGuidance(root),/Unsupported module declaration/);
  }
});

test('Git readiness adoption refuses application dependencies, dynamic imports and release symlink escapes', t=>{
  const external=releaseFixture(t,{[entry]:"import './project-setup.mjs';\n"});
  assert.throws(()=>buildPinnedGuidance(external.root),/Unsupported Git readiness dependency/);
  const dynamic=releaseFixture(t,{[entry]:"const other = import('./git-readiness-core.mjs');\n"});
  assert.throws(()=>buildPinnedGuidance(dynamic.root),/Unsupported dynamic dependency/);
  const commented=releaseFixture(t,{[entry]:"const other = import /* transport */ ('./git-readiness-core.mjs');\n"});
  assert.throws(()=>buildPinnedGuidance(commented.root),/Unsupported dynamic dependency/);
  const escaped=releaseFixture(t);
  const outside=join(escaped.root,'..','pp-readiness-outside-'+Date.now()+'.mjs');
  writeFileSync(outside,'fixture');t.after(()=>rmSync(outside,{force:true}));
  rmSync(join(escaped.root,helper));symlinkSync(outside,join(escaped.root,helper));
  assert.throws(()=>buildPinnedGuidance(escaped.root),/Source escapes release/);
});
