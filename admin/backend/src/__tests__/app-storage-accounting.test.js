// Storage accounting: hard links counted once, logical beside allocated,
// partial walks "at least", the unattributed remainder an estimate, the space
// snapshots hold, and the recoverable estimate of a selection with its notes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, summarizeCategories, estimateSelection, formatBytes, FIGURE_SOURCES } from '../lib/app-storage/accounting.js';
import { performCheck } from '../lib/app-storage/perform-check.js';
import * as W from './helpers/app-storage-world.js';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const item = (o) => ({ id: o.id || Math.random().toString(16).slice(2, 18), category: 'temp', status: 'eligible', kind: 'directory', location: 'guest', precision: 'exact', logicalBytes: 0, allocatedBytes: 0, files: 1, dev: 1, ...o });

test('formatBytes uses decimal units with one decimal', () => {
  assert.equal(formatBytes(10.4e9), '10.4 GB');
  assert.equal(formatBytes(2e9), '2 GB');
  assert.equal(formatBytes(850e6), '850 MB');
  assert.equal(formatBytes(12_345), '12.3 KB');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(null), '0 B');
});

test('totals: what the guest sees, what was measured, what is left as an estimate; memory apart from disk', () => {
  const facts = { rootDev: 1, fs: [
    { path: '/', mount: '/', fstype: 'zfs', totalBytes: 100e9, freeBytes: 97e9, availBytes: 97e9 },
    { path: '/tmp', mount: '/tmp', fstype: 'tmpfs', totalBytes: 60e9, freeBytes: 58.9e9, availBytes: 58.9e9 },
    { path: '/run', mount: '/run', fstype: 'tmpfs', totalBytes: 1e9, freeBytes: 0.99e9, availBytes: 0.99e9 },
  ] };
  const items = [
    item({ allocatedBytes: 1e9, logicalBytes: 2e9 }),
    item({ allocatedBytes: 0.5e9, precision: 'at-least' }),
    item({ allocatedBytes: 1.1e9, memoryBacked: true }),
    item({ allocatedBytes: 7e9, location: 'host' }),
    item({ allocatedBytes: 4e9, crossesDevice: true }),
    item({ allocatedBytes: 9e9, dev: 2 }),
    item({ allocatedBytes: 1e8, kind: 'snapshot', category: 'snapshots', location: 'host' }),
  ];
  const host = { usageBytes: 2.9e9, limit: { bytes: 220e9, source: 'root-device' }, datasetName: 'tank/c/pp-x', dataset: { usedBytes: 2.9e9, referencedBytes: 3e9, snapshotsBytes: 1.2e8, datasetBytes: 2.78e9, logicalUsedBytes: 6e9, compressRatio: 2.1, availableBytes: 97e9 } };
  const t = computeTotals({ facts, host, items });
  assert.deepEqual(t.guest, { totalBytes: 100e9, usedBytes: 3e9, availableBytes: 97e9, precision: 'exact', shared: false, source: 'container-df', label: FIGURE_SOURCES['container-df'] });
  assert.equal(t.sharedHostFilesystem, false);
  assert.deepEqual([t.usageSource, t.dataset.source], ['incus-root-usage', 'zfs-dataset'], 'every used figure names where it comes from');
  assert.equal(t.measuredBytes, 1.5e9, 'only guest items on the root filesystem count');
  assert.equal(t.measuredPrecision, 'at-least', 'a partial walk makes the measured figure a lower bound');
  assert.equal(t.unattributedBytes, 1.5e9);
  assert.equal(t.unattributedPrecision, 'estimate');
  assert.deepEqual(t.memoryBacked.map((m) => m.mount), ['/tmp', '/run']);
  assert.ok(Math.abs(t.memoryBacked[0].usedBytes - 1.1e9) < 1e3);
  assert.equal(t.dataset.snapshotsBytes, 1.2e8);
  assert.equal(t.limit.bytes, 220e9);
  assert.equal(computeTotals({ facts: null, host }).unattributedBytes, null, 'nothing is estimated when the guest was not measured');
});

test('categories: status per category, eligible bytes, worst precision, logical beside allocated', () => {
  const cats = summarizeCategories([
    item({ category: 'temp', status: 'eligible', allocatedBytes: 10, logicalBytes: 30 }),
    item({ category: 'temp', status: 'protected', allocatedBytes: 5, precision: 'at-least' }),
    item({ category: 'data', status: 'protected', allocatedBytes: 7 }),
    item({ category: 'logs', status: 'eligible', kind: 'journal', allocatedBytes: 900, recoverableBytes: 600 }),
    item({ category: 'other', status: 'investigate', kind: 'pseudo', allocatedBytes: 50, precision: 'estimate' }),
    item({ category: 'temp', kind: 'group', memberCount: 263, status: 'eligible', allocatedBytes: 1 }),
  ]);
  const by = Object.fromEntries(cats.map((c) => [c.key, c]));
  assert.deepEqual(cats.map((c) => c.key), ['running_app', 'dependencies', 'data', 'releases', 'workspaces', 'archives', 'caches', 'test_reports', 'temp', 'logs', 'history', 'snapshots', 'exports', 'other']);
  assert.deepEqual([by.temp.status, by.temp.eligibleCount, by.temp.eligibleBytes, by.temp.allocatedBytes, by.temp.logicalBytes, by.temp.precision], ['mixed', 2, 11, 16, 30, 'at-least']);
  assert.equal(by.temp.count, 1 + 1 + 263, 'a group counts its members');
  assert.equal(by.data.status, 'protected');
  assert.equal(by.logs.eligibleBytes, 600, 'a journal frees only what is above its limit');
  assert.equal(by.other.precision, 'estimate');
  assert.equal(by.releases.status, 'empty');
  assert.equal(by.snapshots.separate, true);
});

test('estimateSelection: deduped, memory apart, snapshot notes, all snapshots counted as the held total, ids checked', () => {
  const check = {
    totals: { dataset: { snapshotsBytes: 120e6 } },
    items: [
      item({ id: 'a', allocatedBytes: 100, logicalBytes: 300 }),
      item({ id: 'b', allocatedBytes: 50, memoryBacked: true }),
      item({ id: 'j', category: 'logs', kind: 'journal', allocatedBytes: 900, recoverableBytes: 600 }),
      item({ id: 'p', status: 'protected', reason: 'In use by a running process.' }),
      item({ id: 's1', category: 'snapshots', kind: 'snapshot', allocatedBytes: 40e6, location: 'host' }),
      item({ id: 's2', category: 'snapshots', kind: 'snapshot', allocatedBytes: 30e6, location: 'host' }),
      item({ id: 'e1', category: 'exports', kind: 'export', allocatedBytes: 1e9, location: 'host' }),
      item({ id: 'h', allocatedBytes: 10, precision: 'at-least' }),
    ],
  };
  const files = estimateSelection(check, { items: ['a', 'a', 'b', 'p', 's1', 'zz'] });
  assert.equal(files.count, 2);
  assert.equal(files.diskBytes, 100);
  assert.equal(files.memoryBytes, 50);
  assert.equal(files.bytes, 150);
  assert.equal(files.logicalBytes, 300, 'logical beside allocated');
  assert.deepEqual(files.unknownIds, ['zz']);
  assert.deepEqual(files.notEligible.map((x) => x.id), ['p', 's1'], 'protected items and snapshots in the file list are refused');
  assert.ok(files.notes.includes('Space held by snapshots is only returned after those snapshots are deleted.'));
  assert.ok(files.notes.some((n) => /^Memory, not disk/.test(n)));
  const one = estimateSelection(check, { snapshots: ['s1'] });
  assert.equal(one.snapshotBytes, 40e6, 'one snapshot frees what only it holds');
  assert.equal(one.notes.some((n) => /returned after/.test(n)), false);
  const all = estimateSelection(check, { items: ['a'], snapshots: ['s1', 's2'], exports: ['e1'] });
  assert.equal(all.snapshotBytes, 120e6, 'every snapshot selected → the held total, about');
  assert.equal(all.precision, 'estimate');
  assert.ok(all.notes.some((n) => /Every snapshot is selected/.test(n)));
  assert.equal(all.exportBytes, 1e9);
  assert.equal(all.bytes, 100 + 120e6 + 1e9);
  assert.deepEqual(all.byCategory.map((c) => [c.key, c.count]), [['temp', 1], ['snapshots', 2], ['exports', 1]]);
  const journal = estimateSelection(check, { items: ['j'] });
  assert.equal(journal.bytes, 600);
  assert.ok(journal.notes.some((n) => /journal figure is an estimate/.test(n)));
  assert.ok(estimateSelection(check, { items: ['h'] }).notes.some((n) => /lower bounds/.test(n)));
  assert.equal(estimateSelection(check, {}).bytes, 0);
});

test('on real files: a hard link shared between a data folder and a leftover is counted once', async (t) => {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  const r = await performCheck({ target: W.nodusTarget(world), exec: W.scriptedExec({ prefix: root }), now: NOW, checkId: 'chk_00000000-0000-4000-8000-000000000002', listExports: () => [] });
  const data = r.items.find((it) => it.path === '/var/lib/nodus');
  const w48 = r.items.find((it) => it.path === '/opt/nodus-w48');
  assert.ok(w48.sharedBytes >= 900, 'the leftover records the shared bytes');
  assert.ok(data.allocatedBytes >= 4096, 'the data folder (walked first) carries them');
  // Logical and allocated are both reported for every measured item.
  for (const it of r.items.filter((x) => x.location === 'guest' && x.kind !== 'pseudo')) {
    assert.equal(typeof it.logicalBytes, 'number');
    assert.equal(typeof it.allocatedBytes, 'number');
  }
  const measured = r.items.filter((x) => x.location === 'guest' && x.kind !== 'pseudo' && !x.memoryBacked).reduce((s, x) => s + x.allocatedBytes, 0);
  assert.equal(r.totals.measuredBytes, measured);
  const pseudo = r.items.find((it) => it.kind === 'pseudo');
  assert.equal(pseudo.allocatedBytes, r.totals.unattributedBytes);
  assert.equal(pseudo.precision, 'estimate');
});

test('hard links: the collector records hard-linked bytes per item and the estimate says the figure is uncertain', async (t) => {
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  const r = await performCheck({ target: W.nodusTarget(world), exec: W.scriptedExec({ prefix: root }), now: NOW, checkId: 'chk_00000000-0000-4000-8000-000000000003', listExports: () => [] });
  const data = r.items.find((it) => it.path === '/var/lib/nodus');
  assert.ok(data.hardLinkedBytes >= 900, 'the item that carries the shared file records its hard-linked bytes');
  const est = estimateSelection({ items: [item({ id: 'x', allocatedBytes: 5000, hardLinkedBytes: 4096 })] }, { items: ['x'] });
  assert.equal(est.precision, 'estimate');
  assert.equal(est.hardLinkedBytes, 4096);
  assert.ok(est.notes.some((n) => /hard links/.test(n)));
  assert.equal(estimateSelection({ items: [item({ id: 'y', allocatedBytes: 5000 })] }, { items: ['y'] }).precision, 'exact');
});

/* ---- review findings 8 and 12 ---- */

test('categories keep disk and memory apart; "mixed" only when something can be cleaned up', () => {
  const cats = Object.fromEntries(summarizeCategories([
    item({ category: 'temp', allocatedBytes: 100, logicalBytes: 90 }),
    item({ category: 'temp', allocatedBytes: 50, logicalBytes: 40, memoryBacked: true }),
    item({ category: 'temp', status: 'protected', allocatedBytes: 20, memoryBacked: true }),
    item({ category: 'other', status: 'protected' }), item({ category: 'other', status: 'investigate' }),
    item({ category: 'data', status: 'protected' }), item({ category: 'data', status: 'eligible' }),
  ]).map((c) => [c.key, c]));
  assert.deepEqual([cats.temp.allocatedBytes, cats.temp.logicalBytes, cats.temp.memoryBytes], [100, 90, 70], 'tmpfs is not counted as disk');
  assert.deepEqual([cats.temp.eligibleBytes, cats.temp.eligibleMemoryBytes, cats.temp.eligibleCount], [100, 50, 2]);
  assert.equal(cats.other.status, 'investigate', 'protected and needs-a-look, nothing cleanable');
  assert.equal(cats.data.status, 'mixed');
});

/* ---- review findings 10 and 17 ---- */

test('a dir or btrfs pool: the figures are the shared host filesystem\'s, flagged, and nothing is estimated from them', async (t) => {
  const facts = { rootDev: 1, fs: [{ path: '/', mount: '/', fstype: 'ext4', totalBytes: 1e12, freeBytes: 5e11, availBytes: 5e11 }] };
  for (const driver of ['dir', 'btrfs']) {
    const tt = computeTotals({ facts, host: { poolDriver: driver, usageBytes: 2e9 }, items: [item({ allocatedBytes: 1e9 })] });
    assert.equal(tt.sharedHostFilesystem, true, driver);
    assert.deepEqual([tt.guest.shared, tt.guest.source], [true, 'shared-host-df']);
    assert.match(tt.guest.label, /shares with other containers/);
    assert.deepEqual([tt.unattributedBytes, tt.unattributedPrecision], [null, null]);
    assert.equal(tt.usageBytes, 2e9);
  }
  assert.equal(computeTotals({ facts, host: { poolDriver: 'lvm' } }).sharedHostFilesystem, false, 'an LVM volume is the container\'s own filesystem');
  const root = W.makeRoot(); t.after(() => W.cleanupRoot(root));
  const world = W.buildNodusGuest(root, NOW);
  const r = await performCheck({ target: W.nodusTarget(world), exec: W.scriptedExec({ prefix: root, driver: 'dir' }), now: NOW, checkId: 'chk_00000000-0000-4000-8000-000000000004', listExports: () => [] });
  assert.equal(r.totals.sharedHostFilesystem, true);
  assert.equal(r.items.some((it) => it.kind === 'pseudo'), false, 'no "Not measured individually" from host-wide numbers');
  assert.ok(r.notes.some((n) => /shares the host filesystem/.test(n)));
});
